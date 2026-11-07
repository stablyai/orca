import { createHash } from 'node:crypto'
import { resolveHookCommandSourcePolicy } from '../../shared/hook-command-source-policy'
import { getSetupTrustContent } from '../../shared/orca-hook-setup-config'
import type { OrcaHooks } from '../../shared/orca-yaml-hook-types'
import type { Repo } from '../../shared/repo-types'
import type { SetupDecision, SetupTrustMismatch } from '../../shared/worktree/create-types'
import type { WorktreeDefaultTabsLaunch } from '../../shared/worktree/launch-types'
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
  repo: Repo,
  createdYamlHooks: OrcaHooks | null,
  decision: SetupDecision | undefined,
  approvedSetupHash: string | undefined
): SetupTrustMismatch | undefined {
  if (approvedSetupHash === undefined) {
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
  return contentHash === approvedSetupHash ? undefined : { contentHash, scriptContent }
}

function wouldRunSetup(repo: Repo, decision: SetupDecision | undefined): boolean {
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
