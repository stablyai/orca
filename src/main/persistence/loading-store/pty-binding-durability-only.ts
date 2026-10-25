import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PtyBindingFastLaneVerdict } from './pty-binding-fast-lane'

// Writer-owned failure publication needs a rollback callback; a matching binding restores nothing.
const MATCHING_BINDING_ROLLBACK = (): void => {}

/** True when memory already holds the binding and only the debounced save is outstanding. */
export function isDurabilityOnlyMatch(verdict: PtyBindingFastLaneVerdict): boolean {
  return verdict.misses.length === 1 && verdict.misses[0] === 'not_durable'
}

/** Keeps writer-owned failure publication without restoring an unchanged binding. */
export function durabilityOnlyBindingResult(hostId: ExecutionHostId): {
  value: true
  rollback: () => void
  writtenHostIds: ExecutionHostId[]
} {
  return { value: true, rollback: MATCHING_BINDING_ROLLBACK, writtenHostIds: [hostId] }
}
