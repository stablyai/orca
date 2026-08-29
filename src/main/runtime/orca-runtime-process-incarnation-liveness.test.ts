import { describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import { OrcaRuntimeService } from './orca-runtime'

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
    expect(listProcesses).toHaveBeenNthCalledWith(1, 'ssh-1', {
      deadlineMs: expect.any(Number)
    })
    expect(listProcesses).toHaveBeenNthCalledWith(2, 'ssh-1', {
      deadlineMs: expect.any(Number)
    })
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

  it('keeps a live legacy-provider process without incarnation identity unverifiable', async () => {
    const ptyId = 'folder:workspace@@pty-1'
    const runtime = runtimeWithInventory(
      vi
        .fn()
        .mockResolvedValueOnce([{ id: ptyId, cwd: '', title: 'coordinator' }])
        .mockResolvedValueOnce([
          { id: ptyId, incarnationId: 'now-reported', cwd: '', title: 'coordinator' }
        ])
    )

    const inspect = () =>
      runtime.inspectTerminalProcessIncarnationLiveness(
        `runtime-epoch:${ptyId}:7`,
        JSON.stringify({ kind: 'local', hostId: 'local' })
      )
    await expect(inspect()).resolves.toBe('unverifiable')
    await expect(inspect()).resolves.toBe('unverifiable')
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
    expect(listProcesses).toHaveBeenCalledWith(connectionId, {
      deadlineMs: expect.any(Number)
    })
  })
})
