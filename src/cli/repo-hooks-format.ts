import { resolveHookCommandSourcePolicy } from '../shared/hook-command-source-policy'
import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  RepoHookSettings,
  SetupAgentStartupPolicy,
  SetupRunPolicy
} from '../shared/orca-yaml-hook-types'
import {
  DEFAULT_SETUP_AGENT_STARTUP_POLICY,
  shouldWaitForSetupBeforeAgentStartup
} from '../shared/setup-agent-startup-policy'

export type RepoHooksRead = {
  repoId: string
  displayName: string
  hookSettings: RepoHookSettings | undefined
  /** `repo.hooks`: what the execution host would actually run. */
  effective: OrcaHooks | null
  /** `repo.hooksCheck`: the committed `orca.yaml`, unmerged, plus how the read went. */
  sharedCheck: { status: 'ok' | 'error'; hasHooks: boolean; hooks: OrcaHooks | null }
  hasHooksFile: boolean
  setupRunPolicy: SetupRunPolicy
}

export type RepoHooksView = {
  repo: string
  displayName: string
  orcaYaml: 'present' | 'absent' | 'unreadable' | 'unverifiable'
  setupRunPolicy: SetupRunPolicy
  setupAgentStartupPolicy: SetupAgentStartupPolicy
  /** What the user set; null means Orca resolves it per script. */
  commandSourcePolicy: HookCommandSourcePolicy | null
  resolvedCommandSourcePolicy: { setup: HookCommandSourcePolicy; archive: HookCommandSourcePolicy }
  scripts: {
    setup: RepoHookScriptView
    archive: RepoHookScriptView
  }
}

type RepoHookScriptView = {
  local: string | null
  shared: string | null
  effective: string | null
}

export function buildRepoHooksView(read: RepoHooksRead): RepoHooksView {
  const localSetup = read.hookSettings?.scripts.setup
  const localArchive = read.hookSettings?.scripts.archive
  const rawCommandSource = read.hookSettings?.commandSourcePolicy
  return {
    repo: read.repoId,
    displayName: read.displayName,
    orcaYaml: describeOrcaYaml(read),
    setupRunPolicy: read.setupRunPolicy,
    // Why: the runner waits when either side asks for it, so neither one alone is the answer.
    setupAgentStartupPolicy: shouldWaitForSetupBeforeAgentStartup(
      read.hookSettings?.setupAgentStartupPolicy,
      read.sharedCheck.hooks?.setupAgentStartupPolicy
    )
      ? 'wait-for-setup'
      : DEFAULT_SETUP_AGENT_STARTUP_POLICY,
    commandSourcePolicy: rawCommandSource ?? null,
    resolvedCommandSourcePolicy: {
      setup: resolveHookCommandSourcePolicy(rawCommandSource, {
        hasLocalScript: Boolean(localSetup?.trim())
      }),
      archive: resolveHookCommandSourcePolicy(rawCommandSource, {
        hasLocalScript: Boolean(localArchive?.trim())
      })
    },
    scripts: {
      setup: {
        local: blankToNull(localSetup),
        shared: blankToNull(read.sharedCheck.hooks?.scripts.setup),
        effective: blankToNull(read.effective?.scripts.setup)
      },
      archive: {
        local: blankToNull(localArchive),
        shared: blankToNull(read.sharedCheck.hooks?.scripts.archive),
        effective: blankToNull(read.effective?.scripts.archive)
      }
    }
  }
}

/** A read the host could not complete is never reported as "no orca.yaml here". */
function describeOrcaYaml(read: RepoHooksRead): RepoHooksView['orcaYaml'] {
  if (read.sharedCheck.status === 'error') {
    return 'unverifiable'
  }
  if (read.sharedCheck.hasHooks && read.sharedCheck.hooks === null) {
    return 'unreadable'
  }
  return read.hasHooksFile || read.sharedCheck.hasHooks ? 'present' : 'absent'
}

export function formatRepoHooks(view: RepoHooksView): string {
  return [
    `repo: ${view.repo}  ${view.displayName}`,
    `orca.yaml: ${view.orcaYaml}`,
    `setupRunPolicy: ${view.setupRunPolicy}`,
    `setupAgentStartupPolicy: ${view.setupAgentStartupPolicy}`,
    ...formatCommandSource(view),
    '',
    ...formatScript('setup', view.scripts.setup),
    '',
    ...formatScript('archive', view.scripts.archive)
  ].join('\n')
}

/** Setup and archive resolve separately when no policy is set, and can land on different answers. */
function formatCommandSource(view: RepoHooksView): string[] {
  if (view.commandSourcePolicy) {
    return [`commandSource: ${view.commandSourcePolicy}`]
  }
  const { setup, archive } = view.resolvedCommandSourcePolicy
  if (setup === archive) {
    return [`commandSource: ${setup} (resolved)`]
  }
  return [
    `commandSource (setup): ${setup} (resolved)`,
    `commandSource (archive): ${archive} (resolved)`
  ]
}

function formatScript(name: string, script: RepoHookScriptView): string[] {
  return [
    `${name} script (local):`,
    ...indent(script.local),
    `${name} script (orca.yaml):`,
    ...indent(script.shared),
    `${name} script (effective):`,
    ...indent(script.effective)
  ]
}

function indent(script: string | null): string[] {
  if (script === null) {
    return ['  (none)']
  }
  return script
    .trimEnd()
    .split('\n')
    .map((line) => `  ${line}`)
}

function blankToNull(script: string | undefined): string | null {
  return script?.trim() ? script : null
}
