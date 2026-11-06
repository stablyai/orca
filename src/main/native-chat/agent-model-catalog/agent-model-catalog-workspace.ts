import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentModelCatalogBinding } from './agent-model-catalog-snapshot'
import { independentAgentModelCatalog } from '../../../shared/agent-session/options/agent-model-catalog-ownership'
import {
  type AgentSessionAccountHome,
  isLegacyAgentSessionAccountHome
} from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type {
  AgentModelCatalogConfiguredChoice,
  AgentModelCatalogListing
} from './agent-model-catalog-entry'
import type { AgentModelCatalogStore } from './agent-model-catalog-store'
import type { ProjectModelOverride } from './agent-project-model-override'

export type AgentModelCatalogRecord = Pick<
  AgentSessionRecord,
  'sessionId' | 'provider' | 'providerHandleChain' | 'accountHome' | 'location' | 'launchDirectory'
>

export type AgentModelCatalogWorkspaceDeps = {
  store: AgentModelCatalogStore
  /** Project-scoped catalogs require a folder and cannot be prewarmed. */
  listsInChatFolder?: ReadonlySet<string>
  recordWorkspacePath?: (record: AgentModelCatalogRecord) => Promise<string | null>
  /** Account-home config is already covered by discovery; only workspace layers can override it. */
  /** A boolean answers both: whether the project may pick the model, and the effort. */
  workspaceMayOverrideDefaultModel?: (input: {
    agent: string
    workspacePath: string
    accountHomePath: string | null
  }) => Promise<boolean | ProjectModelOverride>
}

async function workspaceOverride(
  deps: AgentModelCatalogWorkspaceDeps,
  input: { agent: string; workspacePath: string; accountHomePath: string | null }
): Promise<ProjectModelOverride> {
  const found = await deps.workspaceMayOverrideDefaultModel?.(input)
  return typeof found === 'object' ? found : { model: found ?? true, effort: found ?? true }
}

/** Whether the account's default model and effort hold in this workspace. */
export async function workspaceKeepsListedDefaults(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  accountHomePath: string | null
): Promise<{ model: boolean; effort: boolean }> {
  if (workspacePath === undefined) {
    return { model: true, effort: true }
  }
  if (workspacePath === null || !deps.workspaceMayOverrideDefaultModel) {
    return { model: false, effort: false }
  }
  try {
    const found = await workspaceOverride(deps, { agent, workspacePath, accountHomePath })
    return { model: !found.model, effort: !found.effort }
  } catch {
    return { model: false, effort: false }
  }
}

/** null means the host cannot inspect this session's workspace. */
export async function sessionWorkspacePath(
  deps: AgentModelCatalogWorkspaceDeps,
  record: AgentModelCatalogRecord
): Promise<string | null> {
  if (!isNativeLocalLocation(record.location) || !deps.recordWorkspacePath) {
    return null
  }
  return deps.recordWorkspacePath(record).catch(() => null)
}

/** Prefer the named workspace, then the session folder; undefined uses account scope. */
export async function catalogFolder(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  session: AgentModelCatalogRecord | undefined
): Promise<string | undefined> {
  if (!deps.listsInChatFolder?.has(agent)) {
    return undefined
  }
  const folder =
    workspacePath === undefined && session
      ? await sessionWorkspacePath(deps, session)
      : workspacePath
  return folder ?? undefined
}

/** Learn account defaults only without workspace overrides; null resolution retires stale facts. */
export async function recordConfiguredDefault(
  deps: AgentModelCatalogWorkspaceDeps & {
    getRecord: (id: string) => AgentSessionRecord | undefined
  },
  record: AgentSessionRecord,
  fingerprint: string,
  choice: AgentModelCatalogConfiguredChoice | null,
  current: () => boolean,
  source?: AgentModelCatalogListing | null
): Promise<void> {
  const accountHome = record.accountHome
  if (!deps.workspaceMayOverrideDefaultModel) {
    return
  }
  const workspacePath = await sessionWorkspacePath(deps, record)
  if (
    !workspacePath ||
    (
      await workspaceOverride(deps, {
        agent: record.provider,
        workspacePath,
        accountHomePath: isLegacyAgentSessionAccountHome(accountHome) ? accountHome.path : null
      })
    ).effort
  ) {
    return
  }
  if (
    current() &&
    deps.getRecord(record.sessionId)?.lease.runtimeFence === record.lease.runtimeFence
  ) {
    deps.store.recordConfiguredDefault(fingerprint, choice, source)
  }
}

/** Default provenance belongs to the resolved binding and the operation projecting it. */
export type AgentModelCatalogListedDefaults = Awaited<
  ReturnType<typeof workspaceKeepsListedDefaults>
>

/** The workspace's own settings, checked once per setup for every reader sharing it. */
export function agentModelCatalogListedDefaults(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  home: AgentSessionAccountHome | null
): Promise<AgentModelCatalogListedDefaults | null> {
  const accountHomePath = home && isLegacyAgentSessionAccountHome(home) ? home.path : null
  // A failed provenance read leaves each binding's conservative projection.
  return workspaceKeepsListedDefaults(deps, agent, workspacePath, accountHomePath).catch(() => null)
}

/** One listing serves every folder on the account; the project decides only its own defaults,
 *  and settings that change only the effort leave the account's model standing. */
export async function projectAgentModelCatalogDefault(
  agent: string,
  bound: AgentModelCatalogBinding,
  defaults: Promise<AgentModelCatalogListedDefaults | null>,
  current: () => boolean
): Promise<void> {
  const keeps = await defaults
  if (keeps && current()) {
    bound.keepDefault = independentAgentModelCatalog(agent) ? keeps.model : keeps.effort
    bound.keepEffort = keeps.effort
  }
}
