import { createHash } from 'node:crypto'
import { resolveHookCommandSourcePolicy } from '../../shared/hook-command-source-policy'
import { getSetupTrustContent } from '../../shared/orca-hook-setup-config'
import type { OrcaHooks } from '../../shared/orca-yaml-hook-types'
import type { WorkspaceHookOwner } from '../../shared/workspace-hook-owner'
import type { SetupDecision, SetupTrustMismatch } from '../../shared/worktree/create-types'
import type { ApprovedSetupHashes } from '../../shared/worktree/creation/approved-setup-hashes'
import type { WorktreeDefaultTabsLaunch } from '../../shared/worktree/creation/launch-types'
import { shouldRunSetupForCreate } from './effective-hook-config'

/** Same digest as the renderer's hashOrcaHookScript, so host and prompt hashes compare. */
export function hashOrcaHookTrustContent(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex')
}

/**
 * Compare the created worktree's shared setup commands with what the client approved.
 * Undefined means run as decided: no approval was sent (older client), nothing shared would run, or it matches.
 */
export function checkCreatedWorktreeSetupTrust(
  repo: WorkspaceHookOwner,
  createdYamlHooks: OrcaHooks | null,
  decision: SetupDecision | undefined,
  approved: ApprovedSetupHashes
): SetupTrustMismatch | undefined {
  const { approvedSetupHash, approvedSetupHashes } = approved
  if (approvedSetupHash === undefined && approvedSetupHashes === undefined) {
    return undefined
  }
  const policy = resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(repo.hookSettings?.scripts.setup?.trim())
  })
  const scriptContent = getSetupTrustContent(createdYamlHooks)
  if (policy === 'local-only' || !scriptContent || !wouldRunSetup(repo, decision)) {
    return undefined
  }
  const contentHash = hashOrcaHookTrustContent(scriptContent)
  const matches = contentHash === approvedSetupHash || approvedSetupHashes?.includes(contentHash)
  return matches ? undefined : { contentHash, scriptContent }
}

/**
 * Older clients send no approval hash. A folder's shared setup never ran before folder setup
 * existed, so it needs an approval or an explicit run rather than starting unseen.
 */
export function folderSharedSetupLacksApproval(
  repo: WorkspaceHookOwner,
  createdYamlHooks: OrcaHooks | null,
  decision: SetupDecision | undefined,
  approved: ApprovedSetupHashes
): boolean {
  if (approved.approvedSetupHash !== undefined || approved.approvedSetupHashes !== undefined) {
    return false
  }
  if (decision === 'run') {
    return false
  }
  const policy = resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(repo.hookSettings?.scripts.setup?.trim())
  })
  return policy !== 'local-only' && Boolean(getSetupTrustContent(createdYamlHooks))
}

function wouldRunSetup(repo: WorkspaceHookOwner, decision: SetupDecision | undefined): boolean {
  try {
    return shouldRunSetupForCreate(repo, decision)
  } catch {
    return false
  }
}

type DefaultTabsLaunch = WorktreeDefaultTabsLaunch | undefined

/** A skipped create opens only the command-less default tabs; an approved run adds the rest. */
export function defaultTabsWithoutCommands(defaultTabs: DefaultTabsLaunch): DefaultTabsLaunch {
  return filterDefaultTabs(defaultTabs, false)
}

export function defaultTabsWithCommands(defaultTabs: DefaultTabsLaunch): DefaultTabsLaunch {
  return filterDefaultTabs(defaultTabs, true)
}

function filterDefaultTabs(
  defaultTabs: DefaultTabsLaunch,
  withCommand: boolean
): DefaultTabsLaunch {
  const tabs = (defaultTabs?.tabs ?? []).filter(
    (tab) => Boolean(tab.command?.trim()) === withCommand
  )
  return defaultTabs && tabs.length > 0 ? { ...defaultTabs, tabs } : undefined
}
