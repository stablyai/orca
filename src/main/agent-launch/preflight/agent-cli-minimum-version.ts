/** Use the last floor at or below the release major, or the first floor for older majors. */
export function agentCliMinimumVersion(
  version: string,
  minimumVersions: readonly string[]
): string | null {
  const major = (value: string): number => Number(value.split('.')[0])
  return (
    minimumVersions.findLast((minimum) => major(minimum) <= major(version)) ??
    minimumVersions[0] ??
    null
  )
}
