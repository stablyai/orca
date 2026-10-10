import { describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import type { SshPortForwardManager } from './ssh-port-forward'
import {
  OrcadManagedIdentityError,
  type OrcadTunnelIdentity
} from './orcad-managed-tunnel-identity'
import { forwardToVerifiedOrcad } from './orcad-managed-tunnel-target'

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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forward manager double never reads it.
    connection: {} as SshConnection,
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
