// Which credential directory a structured Claude child launches against.
//
// Kept out of the runtime class files because those are `@ts-nocheck`, for the reason
// `structured-agent-session-history-adoption.ts` already states: a call site written there would
// compile however wrong it was, and the wrong answer here is another organisation's account.

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import {
  resolveClaudeHomeBindingForWorkspace,
  type ResolvedClaudeHomeBinding
} from '../../shared/claude-home-binding'
import {
  assertClaudeBoundHomeUsable,
  type AssertClaudeBoundHomeUsable
} from './claude-bound-home-refusal'
import { isCustomClaudeConfigDir } from './claude-config-dir-pin'

/** The store accessors the binding decision reads. Each is optional only so a missing one can be
 *  *detected*; see `readClaudeHomeBindingCatalog`. */
export type ClaudeHomeBindingCatalogSource = {
  hasHydratedProjectCatalog?: () => boolean
  getProjectGroups?: () => readonly ProjectGroup[]
  getRepos?: () => readonly Repo[]
  getFolderWorkspaces?: () => readonly FolderWorkspace[]
} | null

export type ClaudeHomeBindingCatalog = {
  groups: readonly ProjectGroup[]
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
}

/**
 * A store that cannot answer refuses by name rather than reading as "no groups": an empty catalog
 * is indistinguishable from "nothing is bound", and answering that launches the shared home for a
 * group that bound another one. A store whose accessors exist but whose profile state has not
 * loaded yet returns `[]` from all three and reads exactly like "nothing is bound", so hydration
 * is asked about separately rather than inferred from the rows.
 */
export function readClaudeHomeBindingCatalog(
  store: ClaudeHomeBindingCatalogSource
): ClaudeHomeBindingCatalog {
  if (
    typeof store?.hasHydratedProjectCatalog !== 'function' ||
    typeof store.getProjectGroups !== 'function' ||
    typeof store.getRepos !== 'function' ||
    typeof store.getFolderWorkspaces !== 'function'
  ) {
    throw new Error('claude_home_binding_catalog_unavailable')
  }
  if (!store.hasHydratedProjectCatalog()) {
    throw new Error('claude_home_binding_catalog_unhydrated')
  }
  return {
    groups: store.getProjectGroups(),
    repos: store.getRepos(),
    folderWorkspaces: store.getFolderWorkspaces()
  }
}

export function resolveClaudeHomeBindingForSession(input: {
  store: ClaudeHomeBindingCatalogSource
  workspaceId: string
  executionHostId: ExecutionHostId | null
}): ResolvedClaudeHomeBinding | null {
  return resolveClaudeHomeBindingForWorkspace({
    ...readClaudeHomeBindingCatalog(input.store),
    workspaceId: input.workspaceId,
    executionHostId: input.executionHostId
  })
}

/**
 * The create-support probe's question, answered fail-closed.
 *
 * Unlike the binding decision below, an unreadable catalog here answers "not bound", which keeps
 * the managed-account gate ON: this can only make the probe refuse, never admit a launch onto the
 * wrong home. The decision that picks a credential directory still refuses by name.
 */
export function hasClaudeHomeBindingForSupport(input: {
  store: ClaudeHomeBindingCatalogSource
  workspaceId: string
  executionHostId: ExecutionHostId | null
  /** Read inside the guard, so settings this probe cannot reach fail closed like the catalog. */
  readChildEnv: () => NodeJS.ProcessEnv
}): boolean {
  try {
    const binding = resolveClaudeHomeBindingForSession(input)
    return Boolean(
      binding && isCustomClaudeConfigDir(binding.configDir, { env: input.readChildEnv() })
    )
  } catch {
    return false
  }
}

/**
 * The environment the Claude child is actually launched with: this process's own, with the agent
 * launch overlay on top (`claude-structured-launch-resolution.ts` merges them the same way). Every
 * check that has to agree with the config-dir pin reads this, never the overlay alone — an ambient
 * CLAUDE_CONFIG_DIR reaches the CLI whether or not the overlay mentions one.
 */
export function claudeChildLaunchEnv(overlay: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...process.env, ...overlay }
}

/**
 * Whether a record's account home is a bound *custom* home — the only state the managed-account
 * gate and the auth-switch settle assertions may be skipped for. A record bound to the home the
 * CLI would find on its own reads the shared runtime auth exactly as an unbound session does, so
 * it keeps every gate.
 */
export function isEffectiveBoundClaudeHome(
  accountHome: ClaudeStructuredAccountHome,
  options: { env: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
): boolean {
  return (
    accountHome.binding?.kind === 'project-group' &&
    isCustomClaudeConfigDir(accountHome.path, options)
  )
}

export type ClaudeStructuredAccountHome = {
  path: string
  binding?: { kind: 'project-group'; groupId: string }
}

/**
 * A group binding outranks every other source, and an unusable one refuses rather than falling
 * back: the user asked for that identity, and quietly substituting the shared home is the
 * silent-wrong-account failure the binding exists to prevent.
 */
export async function resolveClaudeStructuredAccountHome(input: {
  store: ClaudeHomeBindingCatalogSource
  location: {
    executionHostId: ExecutionHostId
    wslDistro: string | null
    workspaceId: string
  }
  launchEnv: NodeJS.ProcessEnv
  /** The account selector's answer for this runtime, when it has one. */
  readSelectedConfigDir: () => string | undefined
  assertBoundHomeUsable?: AssertClaudeBoundHomeUsable
}): Promise<ClaudeStructuredAccountHome> {
  const binding = resolveClaudeHomeBindingForSession({
    store: input.store,
    workspaceId: input.location.workspaceId,
    executionHostId: input.location.executionHostId
  })
  const childEnv = claudeChildLaunchEnv(input.launchEnv)
  if (binding && !isCustomClaudeConfigDir(binding.configDir, { env: childEnv })) {
    // The binding names the home the CLI would find on its own, so the pin emits nothing and the
    // child reads exactly what an unbound session reads. Keep the directory, drop the marker: a
    // no-op binding must not switch off the gates that protect the shared home.
    return { path: binding.configDir }
  }
  if (binding) {
    await (input.assertBoundHomeUsable ?? assertClaudeBoundHomeUsable)({
      binding,
      location: {
        executionHostId: input.location.executionHostId,
        wslDistro: input.location.wslDistro
      },
      launchEnv: childEnv
    })
    return {
      path: binding.configDir,
      binding: { kind: 'project-group', groupId: binding.groupId }
    }
  }
  return {
    path:
      input.launchEnv.CLAUDE_CONFIG_DIR?.trim() ||
      input.readSelectedConfigDir()?.trim() ||
      join(homedir(), '.claude')
  }
}
