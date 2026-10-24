import type { PtyBindingFastLaneVerdict } from './pty-binding-fast-lane'

/** True when memory already holds the binding and only the debounced save is outstanding. */
export function isDurabilityOnlyMatch(verdict: PtyBindingFastLaneVerdict): boolean {
  return verdict.misses.length === 1 && verdict.misses[0] === 'not_durable'
}
