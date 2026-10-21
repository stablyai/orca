/** Starts the one stderr line a provider supervisor writes when it could not start its provider. */
export const PROVIDER_SPAWN_FAILURE_MARKER = '[orca-provider-supervisor] spawn failed: '

type SpawnFailureReport = { thrown: boolean; code: string; message: string }

function parseSpawnFailureReport(line: string): SpawnFailureReport | null {
  if (!line.startsWith(PROVIDER_SPAWN_FAILURE_MARKER)) {
    return null
  }
  let report: unknown
  try {
    report = JSON.parse(line.slice(PROVIDER_SPAWN_FAILURE_MARKER.length))
  } catch {
    return null
  }
  if (
    !report ||
    typeof report !== 'object' ||
    !('thrown' in report && typeof report.thrown === 'boolean') ||
    !('code' in report && typeof report.code === 'string') ||
    !('message' in report && typeof report.message === 'string')
  ) {
    return null
  }
  return { thrown: report.thrown, code: report.code, message: report.message }
}

/** A provider the supervisor could not start: `thrown` when a direct spawn would have thrown. */
export type SupervisedProviderSpawnFailure = { thrown: boolean; error: NodeJS.ErrnoException }

/** The failure a supervisor reported on its last stderr line before exiting 127; null otherwise. */
export function supervisedProviderSpawnFailure(
  code: number | null,
  stderr: string
): SupervisedProviderSpawnFailure | null {
  const report =
    code === 127 ? parseSpawnFailureReport(stderr.trimEnd().split('\n').at(-1) ?? '') : null
  return report
    ? {
        thrown: report.thrown,
        error: Object.assign(new Error(report.message), { code: report.code })
      }
    : null
}

/** Provider stderr as a direct spawn leaves it: a supervisor's report reads as Node's spawn error. */
export function providerStderrForDisplay(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => parseSpawnFailureReport(line)?.message ?? line)
    .join('\n')
}
