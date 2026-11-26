import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type {
  Initialization,
  InitializationTarget
} from './browser-host-page-initialization-records'
import {
  sameInitializationTarget,
  notifyInitialization
} from './browser-host-page-initialization-records'
import { assertBrowserHostPageCommandAdmission } from '../commands/browser-host-page-command-admission'

export function issueInitializationCommand(
  operation: Initialization,
  current: () => void,
  command: BrowserClientHostCommandEvent['command']
) {
  const { state, input, reservation } = operation.admission
  current()
  if (!reservation) {
    throw new Error('browser_page_reconciliation_reservation_stale')
  }
  assertBrowserHostPageCommandAdmission(state.lease, command, (key) =>
    state.executionHostGrants.require(key)
  )
  const issued = state.commandLedger!.issue(
    {
      browserPageId: input.browserPageId,
      pageHostGeneration: reservation.placement.pageHostGeneration,
      command,
      resultAdmission: 'reserved-page'
    },
    () => {
      if (command.type === 'createPage') {
        operation.record.target = {
          authorityRuntimeId: state.lease.authorityRuntimeId,
          authorityEpoch: state.lease.authorityEpoch,
          ...reservation.placement
        }
        operation.record.targetExecutionHostKey = command.executionHostKey
      }
    }
  )
  return awaitInitializationResult(
    issued.result.then((result) => {
      if (result.status === 'failed') {
        throw new Error(result.errorCode)
      }
      return result
    }),
    operation.controller.signal
  )
}

export function closeInitializationGuest(operation: Initialization): Promise<void> {
  const { record, admission } = operation
  const target = record.target
  if (!target || operation.detached) {
    return Promise.resolve()
  }
  if (operation.closing && sameInitializationTarget(operation.closing.target, target)) {
    return operation.closing.result
  }
  const { state, input } = admission
  const issued = state.commandLedger!.issue(
    {
      browserPageId: record.browserPageId,
      pageHostGeneration: target.pageHostGeneration,
      command: { type: 'closePage', targetAuthority: target },
      resultAdmission: 'reconciliation'
    },
    () => {
      operation.cleanupAttempt = {
        target,
        connectionToken: state.connectionToken,
        closed: record.closed,
        stopped: Boolean(record.stopped)
      }
      if (operation.cleanupRequested === state.connectionToken) {
        operation.cleanupRequested = undefined
      }
    }
  )
  const absent = Promise.withResolvers<void>()
  const timer = setTimeout(() => {
    if (!operation.detached && record.operation === operation) {
      notifyInitialization(record, 'cleanup-unknown')
    }
  }, input.closeTimeoutMs ?? 15_000)
  const raw = issued.result.then((result) => {
    if (result.status === 'failed') {
      throw new Error(result.errorCode)
    }
    if (!operation.detached) {
      state.commandLedger!.retirePage(record.browserPageId, target.pageHostGeneration)
    }
  })
  const result = Promise.race([raw, absent.promise])
    .then(() => {
      if (!operation.detached && sameInitializationTarget(record.target, target)) {
        operation.cleanupAttempt = undefined
        operation.cleanupRequested = undefined
        operation.retiredTarget = target
        record.target = undefined
        record.targetExecutionHostKey = undefined
      }
    })
    .finally(() => {
      clearTimeout(timer)
      if (operation.closing?.result === result) {
        operation.closing = undefined
      }
    })
  operation.closing = { target, absent: () => absent.resolve(), result }
  return result
}

export function forgetAbsentInitializationTarget(
  operation: Initialization,
  target: InitializationTarget
): void {
  if (sameInitializationTarget(operation.record.target, target)) {
    operation.retiredTarget = target
    operation.record.target = undefined
  }
  if (operation.closing && sameInitializationTarget(operation.closing.target, target)) {
    operation.closing.absent()
  }
}

export async function awaitInitializationResult<T>(
  result: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let remove = (): void => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => reject(new Error('browser_client_page_initialization_cancelled'))
    if (signal.aborted) {
      abort()
    } else {
      signal.addEventListener('abort', abort, { once: true })
      remove = () => signal.removeEventListener('abort', abort)
    }
  })
  try {
    return await Promise.race([result, aborted])
  } finally {
    remove()
  }
}
