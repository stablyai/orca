import type { PaneSpawnOperation } from '../../../ipc/pty/pane/pane-spawn-operation'
import { classifyPaneSpawnFailure } from '../../../ipc/pty/spawn-failure-settlement'
import type { RetainedTerminalAttempt } from './retained-terminal-attempt'

/** Move the one attempt into its next synchronous settlement owner. */
export function takeRetainedTerminalAttempt(source: { retainedAttempt?: RetainedTerminalAttempt }) {
  const attempt = source.retainedAttempt ?? null
  delete source.retainedAttempt
  return attempt
}

export function settleRetainedTerminalOperationFailure(
  attempt: RetainedTerminalAttempt | null,
  owner: Pick<NonNullable<PaneSpawnOperation['acquisition']>, 'key' | 'reservation'> | undefined,
  error: unknown
): unknown {
  try {
    const outcome = owner?.reservation.outcome
    if (outcome) {
      return attempt?.completed(outcome) ?? error
    }
    const kind = classifyPaneSpawnFailure(owner, error)
    if (kind === 'superseded') {
      attempt?.accepted()
    }
    return kind === 'rejected' ? (attempt?.failed(error) ?? error) : error
  } finally {
    attempt?.finalized()
  }
}

export async function runWithRetainedTerminalAttempt<T>(
  operation: PaneSpawnOperation,
  attempt: RetainedTerminalAttempt | null,
  start: () => Promise<T>
): Promise<T> {
  if (attempt) {
    operation.retainedAttempt = attempt
  }
  try {
    return await start()
  } catch (error) {
    const pending = takeRetainedTerminalAttempt(operation)
    throw pending
      ? settleRetainedTerminalOperationFailure(pending, operation.acquisition, error)
      : error
  } finally {
    takeRetainedTerminalAttempt(operation)?.finalized()
  }
}
