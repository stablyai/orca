import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type { AgentModelCatalogConfiguredChoice } from './agent-model-catalog-entry'
import type { AgentModelCatalogStore } from './agent-model-catalog-store'

/** What a workspace changes about a catalog read: its folder's own catalog, and its default. */
export type AgentModelCatalogWorkspaceDeps = {
  store: AgentModelCatalogStore
  /** Agents that list in the asking chat's folder, whose project config can change their models:
   *  each folder keeps its own catalog, and a prewarm, which names none, skips them. */
  listsInChatFolder?: ReadonlySet<string>
  /** Where a session's provider runs, for deciding whether its own config scope is the account's. */
  recordWorkspacePath?: (record: AgentSessionRecord) => Promise<string | null>
  /** Whether the workspace's own config could pick a model other than the listed default;
   *  `accountHomePath` is the agent's own home folder, which is account config, not a layer. */
  workspaceMayOverrideDefaultModel?: (input: {
    agent: string
    workspacePath: string
    accountHomePath: string | null
  }) => Promise<boolean>
}

/** A named workspace keeps the listed default only when none of its own config can replace it. */
export async function workspaceKeepsListedDefault(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  accountHomePath: string | null
): Promise<boolean> {
  if (workspacePath === undefined) {
    return true
  }
  if (workspacePath === null || !deps.workspaceMayOverrideDefaultModel) {
    return false
  }
  try {
    return !(await deps.workspaceMayOverrideDefaultModel({ agent, workspacePath, accountHomePath }))
  } catch {
    return false
  }
}

/** The local folder a session's agent runs in; null where this host cannot look into it, as a new
 *  chat's own read answers. */
export async function sessionWorkspacePath(
  deps: AgentModelCatalogWorkspaceDeps,
  record: AgentSessionRecord
): Promise<string | null> {
  if (!isNativeLocalLocation(record.location) || !deps.recordWorkspacePath) {
    return null
  }
  return deps.recordWorkspacePath(record).catch(() => null)
}

/** The folder whose catalog a read of `agent` answers from, for an agent whose models differ by
 *  folder: the workspace the read names, else its session's. Undefined keys the account's. */
export async function catalogFolder(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  session: AgentSessionRecord | undefined
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

/** A session launched with no model pick resolved its config scope's default model and effort;
 *  when that scope is the account's (a native workspace with no config of its own), they are the
 *  account's default, and a resolution naming no listed model retires the saved one. */
export async function recordConfiguredDefault(
  deps: AgentModelCatalogWorkspaceDeps,
  record: AgentSessionRecord,
  fingerprint: string,
  choice: AgentModelCatalogConfiguredChoice | null
): Promise<void> {
  const accountHome = record.accountHome
  if (!deps.workspaceMayOverrideDefaultModel) {
    return
  }
  const workspacePath = await sessionWorkspacePath(deps, record)
  if (
    !workspacePath ||
    (await deps.workspaceMayOverrideDefaultModel({
      agent: record.provider,
      workspacePath,
      accountHomePath: isLegacyAgentSessionAccountHome(accountHome) ? accountHome.path : null
    }))
  ) {
    return
  }
  deps.store.recordConfiguredDefault(fingerprint, choice)
}
