import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  MobileSessionTabsStreamHealth,
  type SessionTabsApplyOutcome
} from './mobile-session-tabs-stream-health'

type TestResult = {
  type?: 'snapshot' | 'updated' | 'error' | 'end'
  snapshotVersion: number
  tabs: string[]
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function result(
  snapshotVersion: number,
  type?: TestResult['type'],
  tabs = [`tab-${snapshotVersion}`]
): TestResult {
  return { snapshotVersion, tabs, ...(type ? { type } : {}) }
}

function success(value: TestResult): RpcResponse {
  return {
    id: `list-${value.snapshotVersion}`,
    ok: true,
    result: value,
    _meta: { runtimeId: 'runtime-1' }
  }
}

function failure(): RpcResponse {
  return {
    id: 'list-failure',
    ok: false,
    error: { code: 'unavailable', message: 'try again' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function makeHarness(options?: {
  generation?: { current: number }
  apply?: (value: TestResult) => SessionTabsApplyOutcome<string>
  getApplicationRevision?: () => number
}) {
  const requests: Deferred<RpcResponse>[] = []
  const sendRequest = vi.fn(() => {
    const request = deferred<RpcResponse>()
    requests.push(request)
    return request.promise
  })
  const generation = options?.generation ?? { current: 1 }
  const client = {
    sendRequest,
    getGeneration: () => generation.current
  } as unknown as RpcClient
  const apply =
    options?.apply ??
    vi.fn(
      (value: TestResult): SessionTabsApplyOutcome<string> => ({
        accepted: true,
        effectiveTabs: value.tabs
      })
    )
  const consumeAccepted = vi.fn()
  let recoveryNeeded = false
  const controller = new MobileSessionTabsStreamHealth<TestResult, string>({
    client,
    scope: 'id:repo::worktree',
    apply,
    consumeAccepted,
    hasRecoveryNeed: () => recoveryNeeded,
    getApplicationRevision: options?.getApplicationRevision
  })
  return {
    apply,
    client,
    consumeAccepted,
    controller,
    generation,
    requests,
    sendRequest,
    setRecoveryNeeded(value: boolean) {
      recoveryNeeded = value
    }
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('MobileSessionTabsStreamHealth', () => {
  it('coalesces a cohort and runs one trailing request for a newer requirement', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)

    const first = harness.controller.requestReconciliation()
    const shared = harness.controller.requestReconciliation()

    expect(shared).toBe(first)
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    let sharedSettled = false
    void shared.then(() => {
      sharedSettled = true
    })

    harness.requests[0]!.resolve(success(result(1)))
    await settle()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    expect(sharedSettled).toBe(false)

    harness.requests[1]!.resolve(success(result(2)))
    await first
    expect(sharedSettled).toBe(true)
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    expect(harness.apply).toHaveBeenCalledTimes(2)
  })

  it('starts distinct pre- and post-snapshot lists and discards the stale barrier', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()

    const preSnapshot = harness.controller.ensureReconciliation()
    subscription.listener(result(2, 'snapshot'))
    const postSnapshot = harness.controller.ensureReconciliation()
    expect(harness.controller.ensureReconciliation()).toBe(postSnapshot)

    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    expect(harness.controller.isCertified()).toBe(false)

    harness.requests[0]!.resolve(success(result(1, undefined, ['stale-list'])))
    await preSnapshot
    expect(harness.consumeAccepted).toHaveBeenCalledTimes(1)

    harness.requests[1]!.resolve(success(result(2, undefined, ['post-snapshot'])))
    await postSnapshot
    expect(harness.controller.isCertified()).toBe(true)
    expect(harness.consumeAccepted).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tabs: ['post-snapshot'] }),
      ['post-snapshot'],
      'list'
    )
  })

  it('invalidates live state for a same-generation replayed snapshot', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()
    subscription.listener(result(1, 'updated'))
    expect(harness.controller.isCertified()).toBe(true)

    subscription.listener(result(2, 'snapshot'))
    expect(harness.controller.isCertified()).toBe(false)
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)

    harness.requests[0]!.resolve(success(result(2)))
    await settle()
    expect(harness.controller.isCertified()).toBe(true)
  })

  it('requires a pre-snapshot and post-snapshot list after stable generation migration', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()
    subscription.listener(result(1, 'updated'))
    expect(harness.controller.isCertified()).toBe(true)

    harness.generation.current = 2
    const preSnapshot = harness.controller.poll()
    expect(preSnapshot).not.toBeNull()
    expect(harness.controller.isCertified()).toBe(false)

    subscription.listener(result(2, 'snapshot'))
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)

    harness.requests[0]!.resolve(success(result(2, undefined, ['generation-pre'])))
    await preSnapshot
    harness.requests[1]!.resolve(success(result(2, undefined, ['generation-post'])))
    await settle()

    expect(harness.controller.isCertified()).toBe(true)
    expect(harness.controller.poll()).toBeNull()
    expect(harness.consumeAccepted).not.toHaveBeenCalledWith(
      expect.objectContaining({ tabs: ['generation-pre'] }),
      expect.anything(),
      'list'
    )
  })

  it('ignores old generation results even before the next polling tick', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const pending = harness.controller.requestReconciliation()
    harness.generation.current = 2

    harness.requests[0]!.resolve(success(result(1)))
    await pending

    expect(harness.apply).not.toHaveBeenCalled()
    expect(harness.consumeAccepted).not.toHaveBeenCalled()
  })

  it('keeps a failed requirement pending without an immediate or trailing retry', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const pending = harness.controller.requestReconciliation()
    harness.requests[0]!.resolve(failure())
    await pending
    await settle()

    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    const retry = harness.controller.poll()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.requests[1]!.resolve(success(result(1)))
    await retry
    await settle()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('retries a failed explicit reconciliation even while stream health stays live', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()
    subscription.listener(result(1, 'updated'))

    const failed = harness.controller.requestReconciliation()
    harness.requests[0]!.resolve(failure())
    await failed
    const retry = harness.controller.poll()

    expect(retry).not.toBeNull()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.requests[1]!.resolve(success(result(1)))
    await retry
    expect(harness.controller.poll()).toBeNull()
  })

  it('lets an accepted update satisfy only requirements raised before apply', async () => {
    let controller: MobileSessionTabsStreamHealth<TestResult, string>
    let raisedRequirement: Promise<void> | null = null
    const apply = vi.fn((value: TestResult): SessionTabsApplyOutcome<string> => {
      if (value.type === 'updated') {
        raisedRequirement = controller.requestReconciliation()
      }
      return { accepted: true, effectiveTabs: value.tabs }
    })
    const harness = makeHarness({ apply })
    controller = harness.controller
    controller.setReconciliationActive(true)
    const subscription = controller.beginSubscription()

    subscription.listener(result(1, 'updated'))

    expect(controller.isCertified()).toBe(true)
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    harness.requests[0]!.resolve(success(result(1)))
    await raisedRequirement
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    const retry = controller.poll()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.requests[1]!.resolve(success(result(1)))
    await retry
  })

  it('does not consume a rejected stream snapshot or update', () => {
    const apply = vi.fn(
      (value: TestResult): SessionTabsApplyOutcome<string> =>
        value.type ? { accepted: false } : { accepted: true, effectiveTabs: value.tabs }
    )
    const harness = makeHarness({ apply })
    const subscription = harness.controller.beginSubscription()

    subscription.listener(result(1, 'snapshot'))
    subscription.listener(result(2, 'updated'))

    expect(harness.consumeAccepted).not.toHaveBeenCalled()
    expect(harness.controller.isCertified()).toBe(false)
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })

  it('fences cancelled subscription frames', () => {
    const harness = makeHarness()
    const subscription = harness.controller.beginSubscription()
    subscription.cancel()

    subscription.listener(result(1, 'updated'))

    expect(harness.apply).not.toHaveBeenCalled()
    expect(harness.consumeAccepted).not.toHaveBeenCalled()
  })

  it('records requirements while inactive without issuing background requests', async () => {
    const harness = makeHarness()
    const subscription = harness.controller.beginSubscription()

    subscription.listener(result(1, 'snapshot'))
    subscription.listener({
      type: 'error',
      snapshotVersion: 1,
      tabs: []
    })
    await harness.controller.requestReconciliation()

    expect(harness.sendRequest).not.toHaveBeenCalled()
    harness.controller.setReconciliationActive(true)
    const resumed = harness.controller.ensureReconciliation()
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    harness.requests[0]!.resolve(success(result(1)))
    await resumed
  })

  it('keeps polling a certified stream while local recovery work remains', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()
    subscription.listener(result(1, 'updated'))
    harness.setRecoveryNeeded(true)

    const poll = harness.controller.poll()
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    harness.requests[0]!.resolve(success(result(1)))
    await poll

    harness.setRecoveryNeeded(false)
    expect(harness.controller.poll()).toBeNull()
  })

  it('makes delayed pending-recovery requests no-ops after accepted consumption resolves them', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    expect(await harness.controller.requestPendingRecovery()).toBeUndefined()
    expect(harness.sendRequest).not.toHaveBeenCalled()

    harness.setRecoveryNeeded(true)
    const pending = harness.controller.requestPendingRecovery()
    harness.requests[0]!.resolve(success(result(1)))
    await pending
    harness.setRecoveryNeeded(false)

    await harness.controller.requestPendingRecovery()
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('ignores list results owned by a disposed route controller', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const pending = harness.controller.requestReconciliation()
    harness.controller.dispose()

    harness.requests[0]!.resolve(success(result(1)))
    await pending

    expect(harness.apply).not.toHaveBeenCalled()
    expect(harness.consumeAccepted).not.toHaveBeenCalled()
  })

  it('discards a list after a newer accepted application outside the controller', async () => {
    let applicationRevision = 0
    const harness = makeHarness({
      getApplicationRevision: () => applicationRevision
    })
    harness.controller.setReconciliationActive(true)
    const pending = harness.controller.requestReconciliation()

    applicationRevision += 1
    harness.requests[0]!.resolve(success(result(1)))
    await pending

    expect(harness.apply).not.toHaveBeenCalled()
    expect(harness.consumeAccepted).not.toHaveBeenCalled()
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    const retry = harness.controller.poll()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.requests[1]!.resolve(success(result(2)))
    await retry
    expect(harness.apply).toHaveBeenCalledTimes(1)
  })
})
