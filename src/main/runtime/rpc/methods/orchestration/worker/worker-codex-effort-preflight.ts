import type { OrcaRuntimeService } from '../../../../orca-runtime'

/** Codex's own effort list for the requested model on the host the worker runs on, when known. */
export async function readWorkerCodexDiscoveredEfforts(
  runtime: Pick<OrcaRuntimeService, 'readOrchestrationCodexModelEfforts'>,
  params: { agent?: string; model?: string; effort?: string },
  resolveTarget: () => Promise<{ repo?: string; worktree?: string }>
): Promise<string[] | null> {
  if (params.agent !== 'codex' || !params.model || !params.effort) {
    return null
  }
  try {
    return await runtime.readOrchestrationCodexModelEfforts(await resolveTarget(), params.model)
  } catch {
    // Placement errors surface from worker-start's own resolution below, unchanged.
    return null
  }
}
