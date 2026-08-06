import type { Store } from '../persistence'
import type { ClaudeAccountService } from './service'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-service'
import {
  getClaudeSelectionTargetForAccount,
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { getPreferredClaudeAccountId } from '../../shared/project-claude-account-preference'

export function resolveProjectPreferredClaudeAccountId(
  store: Store,
  worktreeId: string | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const projectId = store.getWorktreeMeta(worktreeId)?.projectId
  if (!projectId) {
    return null
  }
  const project = store.getProjects().find((entry) => entry.id === projectId)
  return project ? getPreferredClaudeAccountId(project.claudeAccountPreference) : null
}

type ProjectAwarePrepareClaudeAuthDeps = {
  getStore: () => Store
  getClaudeAccounts: () => ClaudeAccountService
  prepare: (target?: ClaudeAccountSelectionTarget) => Promise<ClaudeRuntimeAuthPreparation>
}

/**
 * Wraps prepareForClaudeLaunch so a project's preferred managed account is
 * selected (globally, via the existing switch machinery) before the launch
 * materializes credentials. Every unresolvable case falls back to the
 * inherited global selection rather than blocking the launch.
 */
export function createProjectAwarePrepareClaudeAuth(deps: ProjectAwarePrepareClaudeAuthDeps) {
  return async (
    target?: ClaudeAccountSelectionTarget,
    context?: { worktreeId?: string }
  ): Promise<ClaudeRuntimeAuthPreparation> => {
    const store = deps.getStore()
    const preferredAccountId = resolveProjectPreferredClaudeAccountId(store, context?.worktreeId)
    if (!preferredAccountId) {
      return deps.prepare(target)
    }

    const settings = store.getSettings()
    const account = settings.claudeManagedAccounts.find((entry) => entry.id === preferredAccountId)
    if (!account) {
      console.warn(
        `[claude-accounts] Project prefers Claude account ${preferredAccountId}, but it no longer exists; using the global selection.`
      )
      return deps.prepare(target)
    }

    const accountTarget = normalizeClaudeAccountSelectionTarget(
      getClaudeSelectionTargetForAccount(account)
    )
    const launchTarget = normalizeClaudeAccountSelectionTarget(target)
    const runtimeMismatch =
      accountTarget.runtime !== launchTarget.runtime ||
      (launchTarget.wslDistro !== null && launchTarget.wslDistro !== accountTarget.wslDistro)
    if (runtimeMismatch) {
      console.warn(
        `[claude-accounts] Project prefers Claude account ${account.email}, but it belongs to a different runtime than this launch; using the global selection.`
      )
      return deps.prepare(target)
    }

    if (getSelectedClaudeAccountIdForTarget(settings, accountTarget) !== account.id) {
      try {
        await deps.getClaudeAccounts().selectAccountForTarget(account.id)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Could not switch to this project's preferred Claude account (${account.email}): ${reason}`
        )
      }
    }
    return deps.prepare(target)
  }
}
