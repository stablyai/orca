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

  it('retries settlement after persistence fails instead of declaring recovery complete', async () => {
    const fixture = missingWorkspaceRecoveryFixture(undefined, emptyLocalWorkerInventory())
    fixture.persist.mockResolvedValueOnce(new Set())
    const result = await fixture.controller.reconcile()
    expect(result.exitedDispatchIds).toEqual([])
    expect(result.deferredDispatchIds).toEqual(['dispatch-1'])
    expect(fixture.reconcileMissing).not.toHaveBeenCalled()
  })
})
