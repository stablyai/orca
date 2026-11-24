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

/** Preserve whether direct spawn would throw or emit its failure. */
export type SupervisedProviderSpawnFailure = { thrown: boolean; error: NodeJS.ErrnoException }

/** Only exit 127 with a final supervisor report proves provider spawn failure. */
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

/** Render supervisor-reported failures like direct Node spawn errors. */
export function providerStderrForDisplay(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => parseSpawnFailureReport(line)?.message ?? line)
    .join('\n')
}
