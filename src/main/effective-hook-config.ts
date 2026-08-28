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
): OrcaHooks | null {
  const localSetup = repo.hookSettings?.scripts.setup
  const localArchive = repo.hookSettings?.scripts.archive
  const rawPolicy = repo.hookSettings?.commandSourcePolicy
  const setupPolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localSetup?.trim())
  })
  const archivePolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localArchive?.trim())
  })
  const setup = getEffectiveHookScript(yamlHooks?.scripts.setup, localSetup, setupPolicy)
  const archive = getEffectiveHookScript(yamlHooks?.scripts.archive, localArchive, archivePolicy)

  if (!setup && !archive) {
    return null
  }

  // Why: committed `orca.yaml` and local Settings can coexist; the source policy decides which is authoritative.
  return {
    scripts: {
      ...(setup ? { setup } : {}),
      ...(archive ? { archive } : {})
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

export function getDefaultTabCommandTrustContent(hooks: OrcaHooks | null): string {
  const commands = (hooks?.defaultTabs ?? [])
    .map((tab, index) => {
      const command = tab.command?.trim()
      if (!command) {
        return null
      }
      const label = tab.title ? ` ${tab.title}` : ''
      return `# defaultTabs[${index + 1}]${label}\n${command}`
    })
    .filter((entry): entry is string => entry !== null)
  return [hooks?.scripts.setup?.trim(), ...commands].filter(Boolean).join('\n\n')
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
  // Why: local-only repos may use shared tab titles/colors but must not run the committed orca.yaml commands.
  const canRunSharedCommands = sharedCommandPolicy !== 'local-only'
  const runCommands =
    hasCommands && canRunSharedCommands ? shouldRunSetupForCreate(repo, decision) : false
  return { tabs, runCommands }
}
