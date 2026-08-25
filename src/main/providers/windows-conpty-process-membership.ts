/**
 * Foreground polling has no lifecycle owner for one-shot console helpers.
 * Fail closed instead of creating unbounded subprocess fanout.
 */
export function readWindowsConptyProcessIds(_rootPid: number): Promise<ReadonlySet<number> | null> {
  return Promise.resolve(null)
}
