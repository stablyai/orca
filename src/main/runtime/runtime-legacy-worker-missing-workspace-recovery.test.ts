import { afterEach, describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { __cancelLegacyWorkerTerminalRecoveryRetriesForTests } from './runtime-legacy-worker-terminal-recovery-controller'
import {
  emptyLocalWorkerInventory,
  missingWorkspaceRecoveryFixture,
  missingWorkspaceWorker
} from './runtime-legacy-worker-recovery-test-fixture'

afterEach(() => __cancelLegacyWorkerTerminalRecoveryRetriesForTests())

describe('worker recovery after workspace deletion', () => {
  it.each(['repo-1::/deleted/worktree', 'folder:deleted-folder'])(
    'settles an absent PTY for %s using one owning-provider inventory',
    async (worktreeId) => {
      const candidates = Array.from({ length: 100 }, (_, index) =>
        missingWorkspaceWorker({ dispatchId: `dispatch-${index}`, worktreeId })
      )
      const fixture = missingWorkspaceRecoveryFixture(candidates, emptyLocalWorkerInventory())
      const resolveWorkspace = vi.spyOn(fixture.ports, 'resolveWorkspace')

      const result = await fixture.controller.reconcile()

      expect(result.exitedDispatchIds).toHaveLength(100)
      expect(result.deferredDispatchIds).toEqual([])
      expect(fixture.refreshInventory).toHaveBeenCalledExactlyOnceWith([], null)
      expect(resolveWorkspace).toHaveBeenCalledTimes(1)
      expect(fixture.persist).toHaveBeenCalledTimes(1)
      expect(fixture.persist.mock.calls[0][0][0]).toMatchObject({ hostId: 'local' })
      expect(fixture.reconcileMissing).toHaveBeenCalledTimes(100)
      expect(fixture.adopt).not.toHaveBeenCalled()
    }
  )

  it('rechecks each workspace on the next pass without repeating a failed lookup per worker', async () => {
    const candidates = Array.from({ length: 100 }, (_, index) =>
      missingWorkspaceWorker({
        dispatchId: `dispatch-${index}`,
        worktreeId: index < 50 ? 'folder:deleted-folder' : 'repo-1::/deleted/worktree'
      })
    )
    const fixture = missingWorkspaceRecoveryFixture(candidates)
    const resolveWorkspace = vi.spyOn(fixture.ports, 'resolveWorkspace')

    expect((await fixture.controller.reconcile()).deferredDispatchIds).toHaveLength(100)
    expect(resolveWorkspace).toHaveBeenCalledTimes(2)
    expect(fixture.persist).not.toHaveBeenCalled()

    fixture.refreshInventory.mockResolvedValue(emptyLocalWorkerInventory())
    expect((await fixture.controller.reconcile()).exitedDispatchIds).toHaveLength(100)
    expect(resolveWorkspace).toHaveBeenCalledTimes(4)
    expect(fixture.reconcileMissing).toHaveBeenCalledTimes(100)
  })

  it('preserves a live PTY even when it has no workspace-scoped inventory entry', async () => {
    const candidate = missingWorkspaceWorker()
    const fixture = missingWorkspaceRecoveryFixture([candidate], {
      ...emptyLocalWorkerInventory(),
      allLivePtyIds: new Set([candidate.ptyId]),
      terminalIdentityByPtyId: new Map([
        [
          candidate.ptyId,
          { handle: candidate.terminalHandle, incarnationId: candidate.incarnationId }
        ]
      ])
    })

    const result = await fixture.controller.reconcile()

    expect(result.deferredDispatchIds).toEqual([candidate.dispatchId])
    expect(fixture.reconcileMissing).not.toHaveBeenCalled()
    expect(fixture.rollback).not.toHaveBeenCalled()
    expect(fixture.adopt).not.toHaveBeenCalled()
  })

  it('defers a live PTY whose incarnation cannot be verified', async () => {
    const candidate = missingWorkspaceWorker()
    const fixture = missingWorkspaceRecoveryFixture([candidate], {
      ...emptyLocalWorkerInventory(),
      allLivePtyIds: new Set([candidate.ptyId])
    })

    expect((await fixture.controller.reconcile()).deferredDispatchIds).toEqual([
      candidate.dispatchId
    ])
    expect(fixture.reconcileMissing).not.toHaveBeenCalled()
  })

  it('retires the old assignment when the same PTY id has a different incarnation', async () => {
    const candidate = missingWorkspaceWorker()
    const fixture = missingWorkspaceRecoveryFixture([candidate], {
      ...emptyLocalWorkerInventory(),
      allLivePtyIds: new Set([candidate.ptyId]),
      terminalIdentityByPtyId: new Map([
        [candidate.ptyId, { handle: candidate.terminalHandle, incarnationId: 'new-incarnation' }]
      ])
    })

    expect((await fixture.controller.reconcile()).exitedDispatchIds).toEqual([candidate.dispatchId])
    expect(fixture.persist.mock.calls[0][0][0].candidate.incarnationId).toBe(
      candidate.incarnationId
    )
    expect(fixture.adopt).not.toHaveBeenCalled()
  })

  it('never treats local inventory as evidence that an SSH worker exited', async () => {
    const candidate = missingWorkspaceWorker({ ptyId: toAppSshPtyId('server-1', 'pty-remote') })
    const fixture = missingWorkspaceRecoveryFixture([candidate], emptyLocalWorkerInventory())

    await fixture.controller.reconcile()
    expect(fixture.refreshInventory).not.toHaveBeenCalled()
    const result = await fixture.controller.reconcile({ connectionId: 'server-1' })
    expect(fixture.refreshInventory).toHaveBeenCalledExactlyOnceWith([], 'server-1')
    expect(result.deferredDispatchIds).toEqual([candidate.dispatchId])
    expect(fixture.reconcileMissing).not.toHaveBeenCalled()
  })

  it('keeps an SSH worker unverifiable when the current relay has no record of its PTY', async () => {
    const candidate = missingWorkspaceWorker({
      worktreeId: 'folder:deleted-folder',
      ptyId: toAppSshPtyId('server-1', 'pty-remote')
    })
    const fixture = missingWorkspaceRecoveryFixture([candidate], {
      ...emptyLocalWorkerInventory(),
      queriedHostIds: new Set([toSshExecutionHostId('server-1')])
    })

    const result = await fixture.controller.reconcile({ connectionId: 'server-1' })
    expect(result.exitedDispatchIds).toEqual([])
    expect(result.deferredDispatchIds).toEqual([candidate.dispatchId])
    expect(fixture.refreshInventory).toHaveBeenCalledExactlyOnceWith([], 'server-1')
    expect(fixture.reconcileMissing).not.toHaveBeenCalled()
    expect(fixture.rollback).not.toHaveBeenCalled()
  })

  it.each(['ssh:malformed', 'remote:peer-1@@pty-remote'])(
    'does not query a local provider for foreign PTY %s',
    async (ptyId) => {
      vi.useFakeTimers()
      try {
        const fixture = missingWorkspaceRecoveryFixture([missingWorkspaceWorker({ ptyId })])
        await fixture.controller.reconcile()
        expect(fixture.refreshInventory).not.toHaveBeenCalled()
        expect(fixture.reconcileMissing).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each([true, false])(
    'uses an explicit owning-host absence verdict of %s for SSH cleanup',
    async (provenAbsent) => {
      const candidate = missingWorkspaceWorker({ ptyId: toAppSshPtyId('server-1', 'pty-remote') })
      const fixture = missingWorkspaceRecoveryFixture([candidate], {
        ...emptyLocalWorkerInventory(),
        queriedHostIds: new Set([toSshExecutionHostId('server-1')])
      })
      fixture.ports.isTerminalProvenAbsent = vi.fn(async () => provenAbsent)
      const result = await fixture.controller.reconcile({ connectionId: 'server-1' })
      expect(result.exitedDispatchIds).toEqual(provenAbsent ? [candidate.dispatchId] : [])
      expect(result.deferredDispatchIds).toEqual(provenAbsent ? [] : [candidate.dispatchId])
      expect(fixture.reconcileMissing).toHaveBeenCalledTimes(provenAbsent ? 1 : 0)
    }
  )

  it('preserves SSH workers when the owning-host absence probe throws', async () => {
    const candidate = missingWorkspaceWorker({ ptyId: toAppSshPtyId('server-1', 'pty-remote') })
    const fixture = missingWorkspaceRecoveryFixture([candidate], {
      ...emptyLocalWorkerInventory(),
      queriedHostIds: new Set([toSshExecutionHostId('server-1')])
    })
    fixture.ports.isTerminalProvenAbsent = vi.fn(async () => {
      throw new Error('host disconnected')
    })
    expect(
      (await fixture.controller.reconcile({ connectionId: 'server-1' })).deferredDispatchIds
    ).toEqual([candidate.dispatchId])
    expect(fixture.reconcileMissing).not.toHaveBeenCalled()
  })

  it('defers transient workspace lookup failures rather than assuming deletion', async () => {
    const fixture = missingWorkspaceRecoveryFixture(undefined, emptyLocalWorkerInventory())
    fixture.ports.resolveWorkspace = vi.fn(async () => {
      throw new Error('SSH connection lost')
    })
    expect((await fixture.controller.reconcile()).deferredDispatchIds).toEqual(['dispatch-1'])
    expect(fixture.refreshInventory).not.toHaveBeenCalled()
    expect(fixture.reconcileMissing).not.toHaveBeenCalled()
  })

  it('retries settlement after persistence fails instead of declaring recovery complete', async () => {
    const fixture = missingWorkspaceRecoveryFixture(undefined, emptyLocalWorkerInventory())
    fixture.persist.mockResolvedValueOnce(new Set())
    const result = await fixture.controller.reconcile()
    expect(result.exitedDispatchIds).toEqual([])
    expect(result.deferredDispatchIds).toEqual(['dispatch-1'])
    expect(fixture.reconcileMissing).not.toHaveBeenCalled()
  })
})
