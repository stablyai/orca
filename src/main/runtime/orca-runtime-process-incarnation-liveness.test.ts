import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { structuredWorkerIdentities } from './structured-worker-identity'

const SSH_SCOPE = JSON.stringify({ kind: 'ssh', targetId: 'ssh-1' })
const PROCESS_INCARNATION = 'remote:ssh-1:pty-1:inc-1'

function runtimeWithInventory(
  listProcesses: (connectionId?: string | null) => Promise<PtyProcessInfo[]>
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses
  })
  return runtime
}

describe('terminal process incarnation liveness', () => {
  it('classifies only an exact incarnation as live on its owning provider', async () => {
    const listProcesses = vi.fn().mockResolvedValue([
      {
        id: 'remote:ssh-1:pty-1',
        incarnationId: 'inc-1',
        cwd: '',
        title: 'worker'
      }
    ])
    const runtime = runtimeWithInventory(listProcesses)

    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(PROCESS_INCARNATION, SSH_SCOPE)
    ).resolves.toBe('live')
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness('remote:ssh-1:pty-1:inc-old', SSH_SCOPE)
    ).resolves.toBe('exited')
    expect(listProcesses).toHaveBeenNthCalledWith(1, 'ssh-1')
    expect(listProcesses).toHaveBeenNthCalledWith(2, 'ssh-1')
  })

  it('keeps missing or malformed identity and unavailable inventory unverifiable', async () => {
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'remote:ssh-1:pty-1', cwd: '', title: 'worker' }])
      .mockResolvedValueOnce([
        { id: 'remote:ssh-1:pty-1', incarnationId: ' inc-1 ', cwd: '', title: 'worker' }
      ])
      .mockRejectedValueOnce(new Error('provider unavailable'))
    const runtime = runtimeWithInventory(listProcesses)

    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(PROCESS_INCARNATION, SSH_SCOPE)
    ).resolves.toBe('unverifiable')
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(PROCESS_INCARNATION, SSH_SCOPE)
    ).resolves.toBe('unverifiable')
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(PROCESS_INCARNATION, SSH_SCOPE)
    ).resolves.toBe('unverifiable')
  })

  it('does not inspect an unproven host scope', async () => {
    const listProcesses = vi.fn().mockResolvedValue([])
    const runtime = runtimeWithInventory(listProcesses)

    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(PROCESS_INCARNATION, null)
    ).resolves.toBe('unverifiable')
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(PROCESS_INCARNATION, '{"kind":"ssh"}')
    ).resolves.toBe('unverifiable')
    expect(listProcesses).not.toHaveBeenCalled()
  })

  it.each([
    [{ kind: 'local', hostId: 'local' }, null],
    [{ kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }, null]
  ] as const)('uses the local provider inventory for %s scope', async (scope, connectionId) => {
    const listProcesses = vi.fn().mockResolvedValue([])
    const runtime = runtimeWithInventory(listProcesses)

    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness('local-pty:inc-1', JSON.stringify(scope))
    ).resolves.toBe('exited')
    expect(listProcesses).toHaveBeenCalledWith(connectionId)
  })
})

describe('structured worker incarnation liveness', () => {
  const SESSION = '11111111-1111-4111-a111-111111111111'
  const INCARNATION = `structured:${SESSION}`
  const LOCAL_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })

  function installHost(lease: Record<string, unknown>): void {
    setStructuredAgentSessionHost({
      hasSession: () => false,
      deps: {
        store: {
          getRecord: () => ({ location: { executionHostId: 'local', wslDistro: null }, lease })
        }
      }
    } as never)
  }

  afterEach(() => {
    setStructuredAgentSessionHost(null)
    structuredWorkerIdentities.clear()
  })

  it('settles a stopped worker as exited after its identity was forgotten', async () => {
    // Settlement forgets the in-memory identity. Gating on one left the durable resource answering
    // `unverifiable` forever, so its row never reconciled out of `worker-list --terminalState
    // retained` for the life of the DB. The durable agent-session record is what actually knows.
    installHost({
      runtimeKind: 'native',
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed', detail: 'closed', observedAt: 1 },
      runtimeFence: 2
    })
    const runtime = new OrcaRuntimeService()
    expect(structuredWorkerIdentities.getBySessionId(SESSION)).toBeNull()

    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(INCARNATION, LOCAL_SCOPE)
    ).resolves.toBe('exited')
  })

  it('never answers exited from a record that proves no death', async () => {
    installHost({
      runtimeKind: 'native',
      claimStatus: 'live',
      deathEvidence: null,
      runtimeFence: 2
    })
    const runtime = new OrcaRuntimeService()

    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(INCARNATION, LOCAL_SCOPE)
    ).resolves.toBe('unverifiable')
  })

  it('stays unverifiable when no structured host is installed to look with', async () => {
    const runtime = new OrcaRuntimeService()
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(INCARNATION, LOCAL_SCOPE)
    ).resolves.toBe('unverifiable')
  })
})
