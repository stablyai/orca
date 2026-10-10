import type { OrcaRuntimeService } from '../orca-runtime'

export type FederatedLifecycleSettlement =
  | { action: 'completed' | 'failed'; authority: 'run_home' }
  | { action: 'rejected'; code: string; reason: string; authority: 'run_home' }

export function areFederatedLifecycleSettlementsEqual(
  left: FederatedLifecycleSettlement,
  right: FederatedLifecycleSettlement
): boolean {
  return (
    left.action === right.action &&
    (left.action !== 'rejected' ||
      (right.action === 'rejected' && left.code === right.code && left.reason === right.reason))
  )
}

type Waiter = (settlement: FederatedLifecycleSettlement) => void

const waitersByRuntime = new WeakMap<OrcaRuntimeService, Map<string, Set<Waiter>>>()

export function publishFederatedLifecycleSettlement(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  sequence: number,
  settlement: FederatedLifecycleSettlement
): void {
  const waiters = waitersByRuntime.get(runtime)?.get(settlementKey(dispatchId, sequence))
  for (const waiter of waiters ?? []) {
    waiter(settlement)
  }
}

export function waitForFederatedLifecycleSettlement(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  sequence: number,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<FederatedLifecycleSettlement | undefined> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve(undefined)
      return
    }
    const runtimeWaiters = getRuntimeWaiters(runtime)
    const key = settlementKey(dispatchId, sequence)
    const waiters = runtimeWaiters.get(key) ?? new Set<Waiter>()
    runtimeWaiters.set(key, waiters)
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (settlement?: FederatedLifecycleSettlement) => {
      if (timer) {
        clearTimeout(timer)
      }
      options.signal?.removeEventListener('abort', onAbort)
      waiters.delete(onSettlement)
      if (waiters.size === 0) {
        runtimeWaiters.delete(key)
      }
      resolve(settlement)
    }
    const onSettlement: Waiter = (settlement) => finish(settlement)
    const onAbort = () => finish()
    waiters.add(onSettlement)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(), options.timeoutMs)
  })
}

function getRuntimeWaiters(runtime: OrcaRuntimeService): Map<string, Set<Waiter>> {
  const existing = waitersByRuntime.get(runtime)
  if (existing) {
    return existing
  }
  const created = new Map<string, Set<Waiter>>()
  waitersByRuntime.set(runtime, created)
  return created
}

function settlementKey(dispatchId: string, sequence: number): string {
  return `${dispatchId}:${sequence}`
}
