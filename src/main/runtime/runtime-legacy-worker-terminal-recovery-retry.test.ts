import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RuntimeLegacyWorkerTerminalRecoveryController,
  __cancelLegacyWorkerTerminalRecoveryRetriesForTests
} from './runtime-legacy-worker-terminal-recovery-controller'
import type {
  LegacyWorkerRecoveryPorts,
  LegacyWorkerTerminalRecoveryResult
} from './runtime-legacy-worker-terminal-recovery-types'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import {
  missingWorkspaceRecoveryFixture,
  missingWorkspaceWorker,
  emptyLocalWorkerInventory
} from './runtime-legacy-worker-recovery-test-fixture'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'

const DEFERRED_DISPATCH_ID = 'dispatch-1'

const DEFERRED_PLAN: LegacyWorkerTerminalRecoveryPlan = {
  ambiguousDispatchIds: [],
  candidates: [
    {
      dispatchId: DEFERRED_DISPATCH_ID,
      dispatchStatus: 'dispatched',
      contractVersion: 1,
      taskId: 'task-1',
      worktreeId: 'repo-1::/tmp/worktree-a',
      terminalHandle: 'handle-1',
      paneKey: 'tab-1:pane-1',
      tabId: 'tab-1',
      leafId: 'pane-1',
      processIncarnation: 'pty-1:inc-1',
      ptyId: 'pty-1',
      incarnationId: 'inc-1'
    }
  ]
}

const EMPTY_RESULT: LegacyWorkerTerminalRecoveryResult = {
  adoptedDispatchIds: [],
  exitedDispatchIds: [],
  deferredDispatchIds: [DEFERRED_DISPATCH_ID]
}

function armedController(): {
  controller: RuntimeLegacyWorkerTerminalRecoveryController
  reconcile: ReturnType<typeof vi.fn>
} {
  const reconcile = vi.fn(async () => EMPTY_RESULT)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry timer only ever reaches `ports.reconcile`; the rest of the port surface is unreachable from `updateRetry`.
  const ports = { reconcile } as unknown as LegacyWorkerRecoveryPorts
  const controller = new RuntimeLegacyWorkerTerminalRecoveryController(ports)
  controller.updateRetry(DEFERRED_PLAN, new Set([DEFERRED_DISPATCH_ID]), {})
  return { controller, reconcile }
}

describe('RuntimeLegacyWorkerTerminalRecoveryController retry loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    __cancelLegacyWorkerTerminalRecoveryRetriesForTests()
    vi.useRealTimers()
  })

  it('keeps retrying recovery while a worker stays deferred', async () => {
    const { reconcile } = armedController()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])(
    'retries requested releases only when a backlog exists (%s)',
    async (hasBacklog) => {
      const fixture = missingWorkspaceRecoveryFixture()
      vi.spyOn(fixture.ports, 'hasRequestedReleases').mockReturnValue(hasBacklog)
      const release = vi.spyOn(fixture.ports, 'reconcileRequestedReleases')
      await fixture.controller.reconcile()
      expect(release).toHaveBeenCalledTimes(1)
      release.mockClear()

      await vi.advanceTimersByTimeAsync(7_000)

      expect(fixture.reconcile).toHaveBeenCalledTimes(3)
      expect(release).toHaveBeenCalledTimes(hasBacklog ? 3 : 0)
      expect(fixture.persist).not.toHaveBeenCalled()
      expect(fixture.reconcileMissing).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
    }
  )

  it('stops a controller retry loop once its scopes are cancelled', async () => {
    const { controller, reconcile } = armedController()

    controller.cancelAllRetries()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(reconcile).not.toHaveBeenCalled()
  })

  it('reaches every armed controller from the test cancel hook', async () => {
    // Why the hook exists: the retry re-arms itself for as long as a worker stays deferred, so a
    // suite that never resolves one keeps a recovery loop — and the worktree scans it issues —
    // running inside whichever later test happens to be executing when the timer fires.
    const first = armedController()
    const second = armedController()

    __cancelLegacyWorkerTerminalRecoveryRetriesForTests()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(first.reconcile).not.toHaveBeenCalled()
    expect(second.reconcile).not.toHaveBeenCalled()
  })

  it('keeps automatic recovery available without persistence work while the host is unverifiable', async () => {
    const fixture = missingWorkspaceRecoveryFixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await fixture.controller.reconcile()
      await vi.advanceTimersByTimeAsync(600_000)

      expect(fixture.reconcile).toHaveBeenCalledTimes(23)
      expect(fixture.reconcileMissing).not.toHaveBeenCalled()
      expect(fixture.persist).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
      expect(warning).not.toHaveBeenCalled()

      await fixture.controller.reconcile({ materializeRenderer: true })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fixture.reconcile).toHaveBeenCalledTimes(24)
      expect(fixture.reconcile).toHaveBeenLastCalledWith({
        retry: true,
        dispatchIds: [DEFERRED_DISPATCH_ID],
        materializeRenderer: true
      })
    } finally {
      warning.mockRestore()
    }
  })

  it('keeps every host timer cancellable after extended recovery', async () => {
    const local = missingWorkspaceWorker()
    const remote = missingWorkspaceWorker({
      dispatchId: 'dispatch-remote',
      ptyId: toAppSshPtyId('server-1', 'pty-remote')
    })
    const fixture = missingWorkspaceRecoveryFixture([local, remote])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await fixture.controller.reconcile()
      await vi.advanceTimersByTimeAsync(31_000)
      await fixture.controller.reconcile({ connectionId: 'server-1' })
      await vi.advanceTimersByTimeAsync(30_000)
      const callsBeforeCancellation = fixture.reconcile.mock.calls.length
      expect(vi.getTimerCount()).toBe(2)

      __cancelLegacyWorkerTerminalRecoveryRetriesForTests()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fixture.reconcile).toHaveBeenCalledTimes(callsBeforeCancellation)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      warning.mockRestore()
    }
  })

  it('backs off when the provider throws and remains cancellable', async () => {
    const { controller, reconcile } = armedController()
    reconcile.mockRejectedValue(new Error('provider unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await vi.advanceTimersByTimeAsync(600_000)
      expect(reconcile).toHaveBeenCalledTimes(23)
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      controller.cancelAllRetries()
      warning.mockRestore()
    }
  })

  it('resets the retry scope when an explicit pass starts after a running timer pass', async () => {
    const fixture = missingWorkspaceRecoveryFixture()
    const timerInventory = Promise.withResolvers<null>()
    const explicitInventory = Promise.withResolvers<null>()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await fixture.controller.reconcile()
      fixture.refreshInventory
        .mockImplementationOnce(() => timerInventory.promise)
        .mockImplementationOnce(() => explicitInventory.promise)
      await vi.advanceTimersByTimeAsync(1_000)

      const explicitPass = fixture.controller.reconcile()
      timerInventory.resolve(null)
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.refreshInventory).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(fixture.reconcile).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)

      explicitInventory.resolve(null)
      await explicitPass
      await vi.advanceTimersByTimeAsync(600_000)
      expect(fixture.reconcile).toHaveBeenCalledTimes(24)
      expect(vi.getTimerCount()).toBe(1)
      expect(fixture.reconcileMissing).not.toHaveBeenCalled()
    } finally {
      timerInventory.resolve(null)
      explicitInventory.resolve(null)
      warning.mockRestore()
    }
  })

  it('automatically recovers a provider that becomes verifiable after two minutes', async () => {
    const fixture = missingWorkspaceRecoveryFixture()
    await fixture.controller.reconcile()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fixture.reconcileMissing).not.toHaveBeenCalled()
    expect(fixture.persist).not.toHaveBeenCalled()

    fixture.refreshInventory.mockResolvedValue(emptyLocalWorkerInventory())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fixture.reconcileMissing).toHaveBeenCalledExactlyOnceWith(missingWorkspaceWorker())
    expect(fixture.persist).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not revisit settled workers or persist empty batches during later retries', async () => {
    const settled = missingWorkspaceWorker({ dispatchId: 'settled', ptyId: 'gone' })
    const deferred = missingWorkspaceWorker()
    const fixture = missingWorkspaceRecoveryFixture([settled, deferred], {
      ...emptyLocalWorkerInventory(),
      allLivePtyIds: new Set([deferred.ptyId])
    })
    const resolve = vi.spyOn(fixture.ports, 'resolveWorkspace')
    await fixture.controller.reconcile()
    expect(fixture.reconcileMissing).toHaveBeenCalledExactlyOnceWith(settled)
    expect(fixture.persist).toHaveBeenCalledTimes(1)
    resolve.mockClear()

    await vi.advanceTimersByTimeAsync(600_000)
    expect(resolve).toHaveBeenCalledTimes(23)
    expect(
      resolve.mock.calls.every(([candidate]) => candidate.dispatchId === deferred.dispatchId)
    ).toBe(true)
    expect(fixture.persist).toHaveBeenCalledTimes(1)
    expect(fixture.reconcileMissing).toHaveBeenCalledTimes(1)
  })
})
