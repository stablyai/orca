import { antigravityEffortRefusal } from '../../../../shared/agent-session/options/antigravity-model-efforts'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RuntimeRepoSelector } from '../../workspaces/catalog/runtime-repo-selector'
import type { TerminalModelDiscoveryParams } from '../../../../shared/rpc-contract/agent-model-discovery-params'

/** Explicit CLI requests are checked against a new CLI listing; saved choices never call this. */
export async function assertAntigravityTerminalEffort(
  runtime: Pick<OrcaRuntimeService, 'discoverTerminalModels'>,
  input: {
    agent?: string
    model?: string
    effort?: string
    worktree?: string
    repo?: RuntimeRepoSelector
  } & Pick<TerminalModelDiscoveryParams, 'folder' | 'cwd'>
): Promise<void> {
  if (input.agent !== 'antigravity' || !input.model || !input.effort) {
    return
  }
  // A repo names the discovery scope, not the future worktree's launch directory.
  if (input.repo && !input.worktree && !input.folder) {
    return
  }
  const result = await runtime
    .discoverTerminalModels(input.worktree, 'antigravity', {
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.folder ? { folder: input.folder } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      uncached: true
    })
    .catch(() => undefined)
  if (!result?.success || result.catalogOrigin !== 'probe') {
    return
  }
  const refusal = antigravityEffortRefusal(result.models, input.model, input.effort)
  if (refusal) {
    throw new OrchestrationError('invalid_argument', refusal, { effectsApplied: false })
  }
}
