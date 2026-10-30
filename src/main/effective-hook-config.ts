import { getDefaultRepoHookSettings } from '../shared/constants'
import { resolveHookCommandSourcePolicy } from '../shared/hook-command-source-policy'
import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  SetupRunPolicy
} from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import type { SetupDecision } from '../shared/worktree/create-types'
import type { WorktreeDefaultTabsLaunch } from '../shared/worktree/launch-types'

export type EffectiveOrcaHooks = OrcaHooks & {
  removeCommands?: readonly string[]
  archiveCommands?: readonly string[]
}

function getEffectiveHookScript(
  yamlScript: string | undefined,
  localScript: string | undefined,
  policy: HookCommandSourcePolicy
): string | undefined {
  const shared = yamlScript?.trim()
  const local = localScript?.trim()

  if (policy === 'local-only') {
    return local || undefined
  }

  if (policy === 'run-both') {
    return [shared, local].filter(Boolean).join('\n') || undefined
  }

  return shared || undefined
}

export function getEffectiveHooksFromConfig(
  repo: Repo,
  yamlHooks: OrcaHooks | null
): EffectiveOrcaHooks | null {
  const localSetup = repo.hookSettings?.scripts.setup
  const localArchive = repo.hookSettings?.scripts.archive
  const localRemove = repo.hookSettings?.scripts.remove
  const rawPolicy = repo.hookSettings?.commandSourcePolicy
  const setupPolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localSetup?.trim())
  })
  const archivePolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localArchive?.trim())
  })
  const setup = getEffectiveHookScript(yamlHooks?.scripts.setup, localSetup, setupPolicy)
  const archive = getEffectiveHookScript(yamlHooks?.scripts.archive, localArchive, archivePolicy)
  const removePolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localRemove?.trim())
  })
  const remove = getEffectiveHookScript(yamlHooks?.scripts.remove, localRemove, removePolicy)

  if (!setup && !archive && !remove) {
    return null
  }

  // The source policy arbitrates between committed orca.yaml and local Settings.
  return {
    ...(archivePolicy === 'run-both' && yamlHooks?.scripts.archive?.trim() && localArchive?.trim()
      ? { archiveCommands: [yamlHooks.scripts.archive.trim(), localArchive.trim()] }
      : {}),
    ...(removePolicy === 'run-both' && yamlHooks?.scripts.remove?.trim() && localRemove?.trim()
      ? { removeCommands: [yamlHooks.scripts.remove.trim(), localRemove.trim()] }
      : {}),
    scripts: {
      ...(setup ? { setup } : {}),
      ...(archive ? { archive } : {}),
      ...(remove ? { remove } : {})
    }
  }
}

export function getEffectiveSetupRunPolicy(repo: Repo): SetupRunPolicy {
  return repo.hookSettings?.setupRunPolicy ?? getDefaultRepoHookSettings().setupRunPolicy!
}

export function shouldRunSetupForCreate(repo: Repo, decision: SetupDecision = 'inherit'): boolean {
  if (decision === 'run') {
    return true
  }
  if (decision === 'skip') {
    return false
  }

  const policy = getEffectiveSetupRunPolicy(repo)
  if (policy === 'ask') {
    throw new Error('Setup decision required for this repository')
  }

  return policy === 'run-by-default'
}

export function getDefaultTabsLaunch(
  hooks: OrcaHooks | null,
  repo: Repo,
  decision: SetupDecision = 'inherit'
): WorktreeDefaultTabsLaunch | undefined {
  const tabs = hooks?.defaultTabs ?? []
  if (tabs.length === 0) {
    return undefined
  }
  const hasCommands = tabs.some((tab) => Boolean(tab.command?.trim()))
  const sharedCommandPolicy = resolveHookCommandSourcePolicy(
    repo.hookSettings?.commandSourcePolicy,
    {
      hasLocalScript: Boolean(repo.hookSettings?.scripts.setup?.trim())
    }
  )
  // Local-only repos may inherit tab styling, but must not run shared commands.
  const canRunSharedCommands = sharedCommandPolicy !== 'local-only'
  const runCommands =
    hasCommands && canRunSharedCommands ? shouldRunSetupForCreate(repo, decision) : false
  return { tabs, runCommands }
}
