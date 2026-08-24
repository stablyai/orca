export type PtyProcessInspectionSource = {
  getForegroundProcess(ptyId: string): Promise<string | null>
  inspectProcess?: (ptyId: string) => Promise<{
    foregroundProcess: string | null
    hasChildProcesses: boolean
    unavailable?: true
  }>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
}

export type PtyProcessLivenessEvidence =
  | {
      status: 'live'
      foregroundProcess: string | null
      hasChildProcesses: boolean | null
    }
  | { status: 'unverifiable'; reason: string }
  | { status: 'exited' }

export async function inspectPtyProcess(
  source: PtyProcessInspectionSource,
  ptyId: string
): Promise<PtyProcessLivenessEvidence> {
  try {
    if (source.inspectProcess) {
      const inspection = await source.inspectProcess(ptyId)
      return inspection.unavailable
        ? { status: 'unverifiable', reason: 'process inspection unavailable' }
        : {
            status: 'live',
            foregroundProcess: inspection.foregroundProcess,
            hasChildProcesses: inspection.hasChildProcesses
          }
    }
    const foregroundProcess = await source.getForegroundProcess(ptyId)
    return {
      status: 'live',
      foregroundProcess,
      hasChildProcesses: source.hasChildProcesses ? await source.hasChildProcesses(ptyId) : null
    }
  } catch (error) {
    if (isTerminalGoneError(error)) {
      return { status: 'exited' }
    }
    throw error
  }
}

export function describeProcessInspectionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTerminalGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  return message === 'terminal_gone' || code === 'terminal_gone'
}
