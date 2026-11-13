import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import type { Repo } from '../../../../shared/repo-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { stopMissingWorktreeTerminals } from './missing-worktree-terminal-reconciliation'
import { createAdapter } from '../../../daemon/providers/routing/testing/daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../../../daemon/providers/routing/daemon-pty-router'

function createProvider(sessionIds: string[]): IPtyProvider {
  return {
    listProcesses: vi.fn(async () =>
      sessionIds.map((id) => ({ id, cwd: '/workspace', title: 'shell' }))
    ),
    shutdown: vi.fn(async () => {})
  } as unknown as IPtyProvider
}

function createRuntime(): OrcaRuntimeService {
  return {
    stopTerminalsForWorktree: vi.fn(async () => ({ stopped: 0 }))
  } as unknown as OrcaRuntimeService
}

const localRepo: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1
}

describe('stopMissingWorktreeTerminals', () => {
  it('stops only locally owned worktrees absent from the authoritative scan', async () => {
    const deletedId = 'repo-1::/workspace/deleted'
    const survivingId = 'repo-1::/workspace/surviving'
    const provider = createProvider([
      `${deletedId}@@deleted-session`,
      `${survivingId}@@surviving-session`
    ])
    const runtime = createRuntime()

    const result = await stopMissingWorktreeTerminals(
      localRepo,
      [deletedId, survivingId, 'repo-2::/workspace/other'],
      [survivingId],
      {
        runtime,
        getLocalProvider: () => provider
      }
    )

    expect(result).toEqual({ stoppedWorktreeIds: [deletedId] })
    expect(provider.shutdown).toHaveBeenCalledWith(
      `${deletedId}@@deleted-session`,
      expect.objectContaining({ immediate: true })
    )
    expect(provider.shutdown).not.toHaveBeenCalledWith(
      `${survivingId}@@surviving-session`,
      expect.anything()
    )
  })

  it.each([
    ['legacy connectionId', { connectionId: 'ssh-1' }],
    ['unified executionHostId', { executionHostId: 'ssh:ssh-1' as const }]
  ])('never sweeps an SSH repo (%s) through the local provider', async (_, host) => {
    const deletedId = 'repo-1::/workspace/deleted'
    const localProvider = createProvider([`${deletedId}@@local-session`])
    const runtime = createRuntime()

    await stopMissingWorktreeTerminals({ ...localRepo, ...host }, [deletedId], [], {
      runtime,
      getLocalProvider: () => localProvider
    })

    expect(runtime.stopTerminalsForWorktree).toHaveBeenCalledWith(deletedId, {
      resolvedWorktreeId: deletedId,
      resolvedConnectionId: 'ssh-1'
    })
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(localProvider.shutdown).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'stops multiple workspaces through scoped daemon listings (unrelated duplicate: %s)',
    async (duplicate) => {
      const ids = ['repo-1::/workspace/a', 'repo-1::/workspace/b']
      const targetSessions = ids.map((id) => `${id}@@session`)
      const currentSessions = [...targetSessions, ...(duplicate ? ['unrelated'] : [])]
      const current = createAdapter('current', currentSessions)
      const legacy = createAdapter('legacy', duplicate ? ['unrelated'] : [])
      const provider = new DaemonPtyRouter({ current, legacy: [legacy] })

      await expect(
        stopMissingWorktreeTerminals(localRepo, ids, [], {
          runtime: createRuntime(),
          getLocalProvider: () => provider
        })
      ).resolves.toEqual({ stoppedWorktreeIds: ids })

      expect(currentSessions).toEqual(duplicate ? ['unrelated'] : [])
      expect(
        vi
          .mocked(current.shutdown)
          .mock.calls.map(([id]) => id)
          .sort()
      ).toEqual(targetSessions)
      expect(legacy.shutdown).not.toHaveBeenCalled()
      if (!duplicate) {
        expect(current.listProcesses).toHaveBeenCalledOnce()
      }
    }
  )

  it('does not reuse a failed process scan', async () => {
    const ids = ['repo-1::/workspace/a', 'repo-1::/workspace/b']
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay dropped'))
      .mockResolvedValue([{ id: `${ids[1]}@@session`, cwd: '/workspace', title: 'shell' }])
    const provider = { listProcesses, shutdown: vi.fn(async () => {}) } as unknown as IPtyProvider

    await stopMissingWorktreeTerminals(localRepo, ids, [], {
      runtime: createRuntime(),
      getLocalProvider: () => provider
    })

    expect(listProcesses.mock.calls.length).toBeGreaterThan(1)
    expect(provider.shutdown).toHaveBeenCalledWith(
      `${ids[1]}@@session`,
      expect.objectContaining({ immediate: true })
    )
  })
})
