import type { OrcaRuntimeService } from '../../orca-runtime'

export async function resolveTaskTerminalProvenance(
  runtime: OrcaRuntimeService,
  terminalHandle?: string | null
): Promise<{ worktreeId?: string; branch?: string | null }> {
  if (!terminalHandle) {
    return {}
  }
  try {
    const terminal = await runtime.showTerminal(terminalHandle)
    return {
      worktreeId: terminal.worktreeId,
      branch: terminal.branch || null
    }
  } catch {
    return {}
  }
}
