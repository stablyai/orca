import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type {
  BrowserHostPageReconciliationPlan,
  BrowserHostRuntimePageIntent
} from './browser-host-page-reconciliation-plan'

const DEFAULT_MAX_CONCURRENCY = 4
const MAX_CONCURRENCY = 16
const DEFAULT_ACTION_TIMEOUT_MS = 15_000
const MAX_ACTION_TIMEOUT_MS = 60_000

type ReconciliationPair = BrowserHostPageReconciliationPlan['reclaim'][number]

export type BrowserHostPageReconciliationActions = {
  reclaimPage(pair: ReconciliationPair, signal: AbortSignal): void | Promise<void>
  closePage(page: BrowserClientHostedPageInventory, signal: AbortSignal): void | Promise<void>
  restorePage(intent: BrowserHostRuntimePageIntent, signal: AbortSignal): void | Promise<void>
}

export type BrowserHostPageReconciliationResult = Readonly<{
  retained: number
  reclaimed: number
  closed: number
  restored: number
}>

type ReconciliationAction = Readonly<{
  kind: 'reclaim' | 'close' | 'restore'
  browserPageId: string
  run(signal: AbortSignal): void | Promise<void>
}>

export async function executeBrowserHostPageReconciliation(
  plan: BrowserHostPageReconciliationPlan,
  actions: BrowserHostPageReconciliationActions,
  options: {
    maxConcurrency?: number
    actionTimeoutMs?: number
    signal?: AbortSignal
  } = {}
): Promise<BrowserHostPageReconciliationResult> {
  const maxConcurrency = boundedInteger(
    options.maxConcurrency,
    DEFAULT_MAX_CONCURRENCY,
    MAX_CONCURRENCY,
    'concurrency'
  )
  const actionTimeoutMs = boundedInteger(
    options.actionTimeoutMs,
    DEFAULT_ACTION_TIMEOUT_MS,
    MAX_ACTION_TIMEOUT_MS,
    'timeout'
  )
  const reclaimAndClose = createReclaimAndCloseActions(plan, actions)
  await executePhase(
    reclaimAndClose,
    maxConcurrency,
    actionTimeoutMs,
    options.signal,
    'reclaim/close'
  )
  // Ambiguous authority or destruction outcomes require a fresh plan, never an in-place restore.
  const restore = createRestoreActions(plan, actions)
  await executePhase(restore, maxConcurrency, actionTimeoutMs, options.signal, 'restore')
  return Object.freeze({
    retained: plan.retain.length,
    reclaimed: plan.reclaim.length,
    closed: plan.close.length + plan.closeThenRestore.length,
    restored: plan.restore.length + plan.closeThenRestore.length
  })
}

function createReclaimAndCloseActions(
  plan: BrowserHostPageReconciliationPlan,
  actions: BrowserHostPageReconciliationActions
): readonly ReconciliationAction[] {
  return [
    ...plan.reclaim.map((pair) =>
      reconciliationAction('reclaim', pair.intent.browserPageId, (signal) =>
        actions.reclaimPage(pair, signal)
      )
    ),
    ...plan.close.map((page) =>
      reconciliationAction('close', page.browserPageId, (signal) => actions.closePage(page, signal))
    ),
    ...plan.closeThenRestore.map(({ page }) =>
      reconciliationAction('close', page.browserPageId, (signal) => actions.closePage(page, signal))
    )
  ]
}

function createRestoreActions(
  plan: BrowserHostPageReconciliationPlan,
  actions: BrowserHostPageReconciliationActions
): readonly ReconciliationAction[] {
  return [
    ...plan.restore.map((intent) =>
      reconciliationAction('restore', intent.browserPageId, (signal) =>
        actions.restorePage(intent, signal)
      )
    ),
    ...plan.closeThenRestore.map(({ intent }) =>
      reconciliationAction('restore', intent.browserPageId, (signal) =>
        actions.restorePage(intent, signal)
      )
    )
  ]
}

function reconciliationAction(
  kind: ReconciliationAction['kind'],
  browserPageId: string,
  run: ReconciliationAction['run']
): ReconciliationAction {
  return Object.freeze({ kind, browserPageId, run })
}

async function executePhase(
  actions: readonly ReconciliationAction[],
  maxConcurrency: number,
  actionTimeoutMs: number,
  signal: AbortSignal | undefined,
  phase: 'reclaim/close' | 'restore'
): Promise<void> {
  const failures: (Error | undefined)[] = []
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (!signal?.aborted) {
      const index = nextIndex
      nextIndex += 1
      const action = actions[index]
      if (!action) {
        return
      }
      try {
        await runReconciliationAction(action, actionTimeoutMs, signal)
      } catch (error) {
        failures[index] = new Error(`${action.kind} ${action.browserPageId} failed`, {
          cause: error
        })
      }
    }
  }
  const workers = Math.min(maxConcurrency, actions.length)
  await Promise.all(Array.from({ length: workers }, worker))
  if (signal?.aborted) {
    failures.push(reconciliationAbortError(signal))
  }
  const exactFailures = failures.filter((failure): failure is Error => Boolean(failure))
  if (exactFailures.length > 0) {
    throw new AggregateError(
      exactFailures,
      `Browser host page reconciliation ${phase} phase failed`
    )
  }
}

async function runReconciliationAction(
  action: ReconciliationAction,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined
): Promise<void> {
  if (parentSignal?.aborted) {
    throw reconciliationAbortError(parentSignal)
  }
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeParentAbort = (): void => {}
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('browser_host_page_reconciliation_action_timeout')
      reject(error)
      controller.abort(error)
    }, timeoutMs)
  })
  const parentAbortPromise = new Promise<never>((_resolve, reject) => {
    if (!parentSignal) {
      return
    }
    const abort = (): void => {
      const error = reconciliationAbortError(parentSignal)
      reject(error)
      controller.abort(error)
    }
    parentSignal.addEventListener('abort', abort, { once: true })
    removeParentAbort = () => parentSignal.removeEventListener('abort', abort)
  })
  let actionResult: void | Promise<void>
  try {
    actionResult = action.run(controller.signal)
  } catch (error) {
    actionResult = Promise.reject(error)
  }
  try {
    await Promise.race([Promise.resolve(actionResult), timeoutPromise, parentAbortPromise])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
    removeParentAbort()
  }
}

function reconciliationAbortError(signal: AbortSignal): Error {
  return new Error('browser_host_page_reconciliation_aborted', { cause: signal.reason })
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  errorKind: 'concurrency' | 'timeout'
): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`browser_host_page_reconciliation_${errorKind}_invalid`)
  }
  return resolved
}
