import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executeBrowserHostPageReconciliation,
  type BrowserHostPageReconciliationActions
} from './browser-host-page-reconciliation-executor'
import {
  planBrowserHostPageReconciliation,
  type BrowserClientHostedPageInventory,
  type BrowserHostRuntimePageIntent
} from './browser-host-page-reconciliation-plan'

const inventorySource = { inventoryPairedDeviceId: 'device-a' }

const intent = (
  browserPageId: string,
  overrides: Partial<BrowserHostRuntimePageIntent> = {}
): BrowserHostRuntimePageIntent => ({
  authorityRuntimeId: 'runtime-new',
  authorityEpoch: 'epoch-new',
  browserHostClientId: 'client-a',
  browserHostGeneration: 9,
  browserPageId,
  pageHostGeneration: Number(browserPageId.replace(/\D/g, '')) + 10,
  browserProfileId: 'profile-a',
  executionHostKey: 'native:runtime-new:3',
  ...overrides
})

const page = (
  browserPageId: string,
  overrides: Partial<BrowserClientHostedPageInventory> = {}
): BrowserClientHostedPageInventory => ({
  ...intent(browserPageId),
  state: 'active',
  ...overrides
})

const priorPageAuthority = (
  previous: NonNullable<BrowserHostRuntimePageIntent['reclaimFrom']>
): Partial<BrowserClientHostedPageInventory> => ({
  authorityRuntimeId: previous.authorityRuntimeId,
  authorityEpoch: previous.authorityEpoch,
  browserHostClientId: previous.browserHostClientId,
  browserHostGeneration: previous.browserHostGeneration,
  pageHostGeneration: previous.pageHostGeneration
})

function reconciliationPlan() {
  const previous = {
    authorityRuntimeId: 'runtime-new',
    authorityEpoch: 'epoch-old',
    browserHostClientId: 'client-a',
    browserHostGeneration: 4,
    pageHostGeneration: 12,
    pairedDeviceId: 'device-a'
  }
  return planBrowserHostPageReconciliation(
    [
      intent('page-1'),
      intent('page-2', { reclaimFrom: previous }),
      intent('page-4'),
      intent('page-5')
    ],
    [
      page('page-1'),
      page('page-2', priorPageAuthority(previous)),
      page('page-3'),
      page('page-5', { browserProfileId: 'profile-stale' })
    ],
    inventorySource
  )
}

function actionSpies(): BrowserHostPageReconciliationActions & {
  order: string[]
  phaseOneSettled: () => number
} {
  const order: string[] = []
  let settled = 0
  return {
    order,
    phaseOneSettled: () => settled,
    reclaimPage: vi.fn(async ({ intent: next }) => {
      order.push(`reclaim:${next.browserPageId}`)
      settled += 1
    }),
    closePage: vi.fn(async (target) => {
      order.push(`close:${target.browserPageId}`)
      settled += 1
    }),
    restorePage: vi.fn(async (target) => {
      order.push(`restore:${target.browserPageId}`)
    })
  }
}

describe('browser host page reconciliation executor', () => {
  afterEach(() => vi.useRealTimers())

  it('proves every reclaim and close before restoring any page', async () => {
    const plan = reconciliationPlan()
    const actions = actionSpies()
    actions.restorePage = vi.fn(async (target) => {
      expect(actions.phaseOneSettled()).toBe(3)
      actions.order.push(`restore:${target.browserPageId}`)
    })

    await expect(
      executeBrowserHostPageReconciliation(plan, actions, { maxConcurrency: 2 })
    ).resolves.toEqual({ retained: 1, reclaimed: 1, closed: 2, restored: 2 })

    expect(actions.order.slice(-2).sort()).toEqual(['restore:page-4', 'restore:page-5'])
  })

  it('attempts every safe phase-one action and blocks every restore after one failure', async () => {
    const plan = reconciliationPlan()
    const actions = actionSpies()
    actions.closePage = vi.fn(async (target) => {
      actions.order.push(`close:${target.browserPageId}`)
      if (target.browserPageId === 'page-3') {
        throw new Error('close outcome unknown')
      }
    })

    await expect(
      executeBrowserHostPageReconciliation(plan, actions, { maxConcurrency: 2 })
    ).rejects.toMatchObject({
      message: 'Browser host page reconciliation reclaim/close phase failed',
      errors: [expect.objectContaining({ message: 'close page-3 failed' })]
    })

    expect(actions.reclaimPage).toHaveBeenCalledOnce()
    expect(actions.closePage).toHaveBeenCalledTimes(2)
    expect(actions.restorePage).not.toHaveBeenCalled()
  })

  it('bounds action fanout and restores independent pages after the barrier', async () => {
    const plan = planBrowserHostPageReconciliation(
      Array.from({ length: 8 }, (_, index) => intent(`page-${index + 10}`)),
      [],
      inventorySource
    )
    let active = 0
    let peak = 0
    let release = (): void => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const actions: BrowserHostPageReconciliationActions = {
      reclaimPage: vi.fn(async () => {}),
      closePage: vi.fn(async () => {}),
      restorePage: vi.fn(async () => {
        active += 1
        peak = Math.max(peak, active)
        await released
        active -= 1
      })
    }

    const executing = executeBrowserHostPageReconciliation(plan, actions, { maxConcurrency: 2 })
    await Promise.resolve()
    await Promise.resolve()
    expect(actions.restorePage).toHaveBeenCalledTimes(2)
    release()
    await executing

    expect(peak).toBe(2)
    expect(actions.restorePage).toHaveBeenCalledTimes(8)
  })

  it('stops scheduling on abort and never crosses the restore barrier', async () => {
    const plan = reconciliationPlan()
    const controller = new AbortController()
    const actions = actionSpies()
    actions.reclaimPage = vi.fn(async (_pair, signal) => {
      controller.abort(new Error('authority replaced'))
      expect(signal.aborted).toBe(true)
    })

    await expect(
      executeBrowserHostPageReconciliation(plan, actions, {
        maxConcurrency: 1,
        signal: controller.signal
      })
    ).rejects.toThrow('Browser host page reconciliation reclaim/close phase failed')

    expect(actions.reclaimPage).toHaveBeenCalledOnce()
    expect(actions.closePage).not.toHaveBeenCalled()
    expect(actions.restorePage).not.toHaveBeenCalled()
  })

  it('starts no action when the parent is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('authority already replaced'))
    const actions = actionSpies()

    await expect(
      executeBrowserHostPageReconciliation(reconciliationPlan(), actions, {
        signal: controller.signal
      })
    ).rejects.toThrow('Browser host page reconciliation reclaim/close phase failed')

    expect(actions.reclaimPage).not.toHaveBeenCalled()
    expect(actions.closePage).not.toHaveBeenCalled()
    expect(actions.restorePage).not.toHaveBeenCalled()
  })

  it('reports a synchronous action failure and continues safe phase-one actions', async () => {
    const actions = actionSpies()
    actions.reclaimPage = vi.fn(() => {
      throw new Error('synchronous reclaim rejection')
    })

    await expect(
      executeBrowserHostPageReconciliation(reconciliationPlan(), actions, { maxConcurrency: 1 })
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'reclaim page-2 failed' })]
    })

    expect(actions.closePage).toHaveBeenCalledTimes(2)
    expect(actions.restorePage).not.toHaveBeenCalled()
  })

  it('times out an unsettled close without releasing the restore barrier', async () => {
    vi.useFakeTimers()
    const plan = reconciliationPlan()
    const actions = actionSpies()
    let actionSignal: AbortSignal | undefined
    actions.reclaimPage = vi.fn((_pair, signal) => {
      actionSignal = signal
      return new Promise<void>(() => {})
    })

    const executing = executeBrowserHostPageReconciliation(plan, actions, {
      maxConcurrency: 1,
      actionTimeoutMs: 25
    })
    const rejected = executing.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(25)

    await expect(rejected).resolves.toMatchObject({
      message: 'Browser host page reconciliation reclaim/close phase failed'
    })
    expect(actionSignal?.aborted).toBe(true)
    expect(actions.restorePage).not.toHaveBeenCalled()
  })

  it('cleans the action timer and parent abort listener after settlement', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    await executeBrowserHostPageReconciliation(
      planBrowserHostPageReconciliation([], [], inventorySource),
      actionSpies(),
      { signal: controller.signal }
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(addListener).not.toHaveBeenCalled()
    expect(removeListener).not.toHaveBeenCalled()

    await executeBrowserHostPageReconciliation(
      planBrowserHostPageReconciliation([intent('page-30')], [], inventorySource),
      actionSpies(),
      { signal: controller.signal }
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(1)

    const failingActions = actionSpies()
    failingActions.restorePage = vi.fn(async () => {
      throw new Error('restore failed')
    })
    await expect(
      executeBrowserHostPageReconciliation(
        planBrowserHostPageReconciliation([intent('page-32')], [], inventorySource),
        failingActions,
        { signal: controller.signal }
      )
    ).rejects.toThrow('Browser host page reconciliation restore phase failed')
    expect(vi.getTimerCount()).toBe(0)
    expect(addListener).toHaveBeenCalledTimes(2)
    expect(removeListener).toHaveBeenCalledTimes(2)
  })

  it('handles a late action rejection after timeout', async () => {
    vi.useFakeTimers()
    let rejectAction = (_error: Error): void => {}
    const lateAction = new Promise<void>((_resolve, reject) => {
      rejectAction = reject
    })
    const actions = actionSpies()
    actions.restorePage = vi.fn(() => lateAction)
    const executing = executeBrowserHostPageReconciliation(
      planBrowserHostPageReconciliation([intent('page-31')], [], inventorySource),
      actions,
      { actionTimeoutMs: 25 }
    )
    const rejected = executing.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(25)
    await rejected

    rejectAction(new Error('late action rejection'))
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never restores a close-then-restore page after its exact close fails', async () => {
    const actions = actionSpies()
    actions.closePage = vi.fn(async (target) => {
      if (target.browserPageId === 'page-5') {
        throw new Error('exact close outcome unknown')
      }
    })

    await expect(
      executeBrowserHostPageReconciliation(reconciliationPlan(), actions)
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'close page-5 failed' })]
    })
    expect(actions.restorePage).not.toHaveBeenCalled()
  })

  it('attempts every independent restore and reports exact failed actions', async () => {
    const plan = planBrowserHostPageReconciliation(
      [intent('page-20'), intent('page-21')],
      [],
      inventorySource
    )
    const actions = actionSpies()
    actions.restorePage = vi.fn(async (target) => {
      if (target.browserPageId === 'page-20') {
        throw new Error('restore rejected')
      }
    })

    await expect(executeBrowserHostPageReconciliation(plan, actions)).rejects.toMatchObject({
      message: 'Browser host page reconciliation restore phase failed',
      errors: [expect.objectContaining({ message: 'restore page-20 failed' })]
    })
    expect(actions.restorePage).toHaveBeenCalledTimes(2)
  })

  it('returns an immutable settlement count', async () => {
    const result = await executeBrowserHostPageReconciliation(reconciliationPlan(), actionSpies())

    expect(result).toEqual({ retained: 1, reclaimed: 1, closed: 2, restored: 2 })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it.each([
    [{ maxConcurrency: 0 }, 'concurrency'],
    [{ maxConcurrency: 17 }, 'concurrency'],
    [{ actionTimeoutMs: 0 }, 'timeout'],
    [{ actionTimeoutMs: 60_001 }, 'timeout']
  ])('rejects invalid execution limits %#', async (options, errorKind) => {
    const actions = actionSpies()
    await expect(
      executeBrowserHostPageReconciliation(reconciliationPlan(), actions, options)
    ).rejects.toThrow(`browser_host_page_reconciliation_${errorKind}_invalid`)
    expect(actions.reclaimPage).not.toHaveBeenCalled()
  })
})
