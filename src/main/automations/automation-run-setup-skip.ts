import type { Automation, AutomationDispatchResult } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import { checkCreatedWorktreeSetupTrust } from '../workspace-hooks/created-worktree-setup-trust'
import { loadHooks } from '../workspace-hooks/hooks'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/**
 * Report on the run when its new workspace's setup was skipped because the branch's setup differs
 * from what was approved for the automation; nobody is there to see a prompt.
 */
export async function automationRunSetupSkip(
  runtime: Pick<OrcaRuntimeService, 'showManagedWorktree'>,
  automation: Pick<Automation, 'workspaceMode' | 'setupDecision' | 'setupTrustHash'>,
  repo: Repo,
  workspaceId: string
): Promise<Pick<AutomationDispatchResult, 'setupSkippedReason' | 'setupSkippedContent'>> {
  if (automation.workspaceMode !== 'new_per_run' || !automation.setupTrustHash) {
    return {}
  }
  try {
    const worktree = await runtime.showManagedWorktree(`id:${workspaceId}`)
    const mismatch = checkCreatedWorktreeSetupTrust(
      repo,
      loadHooks(worktree.path),
      automation.setupDecision,
      { approvedSetupHash: automation.setupTrustHash }
    )
    return mismatch ? { setupSkippedReason: 'setup-changed', setupSkippedContent: mismatch } : {}
  } catch {
    // Reporting only; the run itself already started.
    return {}
  }
}
