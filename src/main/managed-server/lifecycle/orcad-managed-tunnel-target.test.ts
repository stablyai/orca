import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import {
  OrcadManagedIdentityError,
  OrcadManagedPairingRejectedError,
  type OrcadTunnelIdentity
} from './orcad-managed-tunnel-identity'
import {
  environmentForwardChecks,
  forwardToVerifiedOrcad,
  MANAGED_ORCAD_TUNNEL_TARGETING
} from './orcad-managed-tunnel-target'
import {
  unusedOrcadHostTransport,
  unusedSshConnection
} from '../../ssh/unused-host-transport.test-fixture'

const mocks = vi.hoisted(() => ({ wake: vi.fn(), resolveContext: vi.fn() }))
vi.mock('./orcad-managed-wake', () => ({ wakeStoppedManagedOrcad: mocks.wake }))
vi.mock('../install/orcad-remote-context', () => ({
  resolveOrcadRemoteContext: mocks.resolveContext
}))

const FOREIGN: OrcadTunnelIdentity = { verdict: 'foreign', detail: '4001: Unauthorized' }

function setup(verdicts: OrcadTunnelIdentity[], rereadPort: number) {
  const addForward = vi.fn(
    async (_id: string, _conn: SshConnection, localPort: number, _host: string, port: number) => ({
      id: `forward-${addForward.mock.calls.length}`,
      localPort: localPort || 41_000,
      remotePort: port
    })
  )
  const removeForwardAndWait = vi.fn().mockResolvedValue(null)
  const verify = vi.fn(async () => verdicts.shift() ?? { verdict: 'verified' as const })
  const rereadRemotePort = vi.fn().mockResolvedValue(rereadPort)
  const args = {
    targetId: 'ssh-1',
    connection: unusedSshConnection(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the two members forwarding calls.
    forwards: { addForward, removeForwardAndWait } as unknown as SshPortForwardManager,
    localPort: 46_768,
    label: 'Managed Orca server',
    remotePort: 6_768,
    rereadRemotePort,
    verify,
    stillCurrent: () => true
  }
  return { addForward, args, removeForwardAndWait, rereadRemotePort, verify }
}

describe('forwardToVerifiedOrcad', () => {
  it.each(['verified', 'unreachable', 'foreign'] as const)(
    'retires a forward superseded during its %s identity check',
    async (verdict) => {
      const state = setup([], 6_768)
      let current = true
      state.verify.mockImplementationOnce(async () => {
        current = false
        return verdict === 'verified' ? { verdict } : { verdict, detail: 'late reply' }
      })
      await expect(
        forwardToVerifiedOrcad({ ...state.args, stillCurrent: () => current })
      ).resolves.toBeNull()
      expect(state.removeForwardAndWait).toHaveBeenCalledWith('forward-1')
      expect(state.rereadRemotePort).not.toHaveBeenCalled()
    }
  )
  it('keeps a forward whose server proves it is this orcad', async () => {
    const state = setup([], 6_768)
    await expect(forwardToVerifiedOrcad(state.args)).resolves.toMatchObject({ remotePort: 6_768 })
    expect(state.rereadRemotePort).not.toHaveBeenCalled()
  })

  it('re-reads the port after another runtime answers, and follows orcad to it', async () => {
    const state = setup([FOREIGN], 58_520)
    await expect(forwardToVerifiedOrcad(state.args)).resolves.toMatchObject({ remotePort: 58_520 })
    expect(state.removeForwardAndWait).toHaveBeenCalledWith('forward-1')
    expect(state.addForward.mock.calls.map((call) => call[4])).toEqual([6_768, 58_520])
  })

  it('fails with the mismatch, never a silent success, when the port did not move', async () => {
    const state = setup([FOREIGN], 6_768)
    const result = forwardToVerifiedOrcad(state.args)
    await expect(result).rejects.toBeInstanceOf(OrcadManagedIdentityError)
    await expect(result).rejects.toThrow(/orcad_identity_mismatch.*remote port 6768/)
    expect(state.removeForwardAndWait).toHaveBeenCalledWith('forward-1')
  })

  it('says the host dropped this pairing, not that another Orca holds the port', async () => {
    const state = setup(
      [{ verdict: 'unpaired', detail: 'Remote Orca runtime rejected the pairing token.' }],
      58_520
    )
    const result = forwardToVerifiedOrcad(state.args)
    await expect(result).rejects.toBeInstanceOf(OrcadManagedPairingRejectedError)
    await expect(result).rejects.toThrow(/no longer accepts this desktop's pairing/)
    await expect(result).rejects.not.toThrow(/another Orca/)
    expect(state.removeForwardAndWait).toHaveBeenCalledWith('forward-1')
    // A pinned server's token refusal needs pairing repair, not a port change.
    expect(state.rereadRemotePort).not.toHaveBeenCalled()
    expect(state.addForward).toHaveBeenCalledTimes(1)
  })

  it('fails when the re-read port is foreign too, without re-reading forever', async () => {
    const state = setup([FOREIGN, FOREIGN], 58_520)
    await expect(forwardToVerifiedOrcad(state.args)).rejects.toThrow(/remote port 58520/)
    expect(state.rereadRemotePort).toHaveBeenCalledTimes(1)
    expect(state.removeForwardAndWait).toHaveBeenCalledTimes(2)
  })

  it('keeps the forward when nothing answers; a stopped server is not a wrong one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = setup([{ verdict: 'unreachable', detail: 'ECONNREFUSED' }], 6_768)
    await expect(forwardToVerifiedOrcad(state.args)).resolves.toMatchObject({ remotePort: 6_768 })
    expect(state.removeForwardAndWait).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops the forward and reports nothing when setup was superseded', async () => {
    const state = setup([], 6_768)
    await expect(
      forwardToVerifiedOrcad({ ...state.args, stillCurrent: () => false })
    ).resolves.toBeNull()
    expect(state.verify).not.toHaveBeenCalled()
    expect(state.removeForwardAndWait).toHaveBeenCalledWith('forward-1')
  })
})

describe('environmentForwardChecks', () => {
  const input = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wake reads only the SSH deployment link.
    environment: {
      orcadDeployment: {
        sshTargetId: 'ssh-1',
        sshTargetGeneration: 1,
        localPort: 46_768,
        remotePort: 6_768
      }
    } as KnownRuntimeEnvironment,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked context resolver only.
    target: { id: 'ssh-1' } as SshTarget,
    connection: unusedOrcadHostTransport()
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.resolveContext.mockResolvedValue({
      connection: {},
      host: { platform: 'linux' },
      remoteHome: '/home/dev',
      userDataDir: '/home/dev/.orca'
    })
  })

  it('starts a server that stopped behind a port another runtime took, then follows it (#28013)', async () => {
    let bound = 6_768
    mocks.wake.mockImplementation(async () => {
      bound = 58_520
      return { outcome: 'started' }
    })
    const targeting = {
      ...MANAGED_ORCAD_TUNNEL_TARGETING,
      resolveRemotePort: vi.fn(async () => bound),
      verifyIdentity: vi.fn(async () => ({ verdict: 'verified' as const }))
    }
    const checks = await environmentForwardChecks(targeting, input)
    const state = setup([FOREIGN], 0)
    await expect(
      forwardToVerifiedOrcad({ ...state.args, ...checks, verify: state.verify })
    ).resolves.toMatchObject({ remotePort: 58_520 })
    expect(mocks.wake).toHaveBeenCalledOnce()
    expect(mocks.wake.mock.calls[0]?.[0]).toMatchObject({ port: 6_768, remoteHome: '/home/dev' })
  })

  it('never wakes for a verified or silent server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const verdict of [
      { verdict: 'verified' as const },
      { verdict: 'unreachable' as const, detail: 'ECONNREFUSED' }
    ]) {
      const checks = await environmentForwardChecks(
        { ...MANAGED_ORCAD_TUNNEL_TARGETING, resolveRemotePort: async () => 6_768 },
        input
      )
      const state = setup([verdict], 0)
      await forwardToVerifiedOrcad({ ...state.args, ...checks, verify: state.verify })
    }
    expect(mocks.wake).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each(['serving', 'unverifiable', 'fenced'] as const)(
    'keeps the mismatch when the wake answers %s and the port did not move',
    async (outcome) => {
      mocks.wake.mockResolvedValue({ outcome })
      const checks = await environmentForwardChecks(
        { ...MANAGED_ORCAD_TUNNEL_TARGETING, resolveRemotePort: async () => 6_768 },
        input
      )
      const state = setup([FOREIGN], 0)
      await expect(
        forwardToVerifiedOrcad({ ...state.args, ...checks, verify: state.verify })
      ).rejects.toBeInstanceOf(OrcadManagedIdentityError)
      expect(mocks.wake).toHaveBeenCalledOnce()
    }
  )

  it('still re-reads the port when the wake itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.resolveContext.mockRejectedValueOnce(new Error('exec lost'))
    const resolveRemotePort = vi.fn(async () => 6_768)
    const checks = await environmentForwardChecks(
      { ...MANAGED_ORCAD_TUNNEL_TARGETING, resolveRemotePort },
      input
    )
    await expect(checks.rereadRemotePort()).resolves.toBe(6_768)
    expect(resolveRemotePort).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
