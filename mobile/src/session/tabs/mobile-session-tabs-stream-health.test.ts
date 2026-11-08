import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc-client'
import type { RpcResponse } from '../../transport/types'
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
    vi.fn((value: TestResult): SessionTabsApplyOutcome<string> => ({
      accepted: true,
      effectiveTabs: value.tabs
    }))
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

describe('MobileSessionTabsStreamHealth', () => {
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

  it('does not consume a rejected stream snapshot or update', () => {
    const apply = vi.fn((value: TestResult): SessionTabsApplyOutcome<string> =>
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
})
