import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { independentAgentModelCatalog } from '../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'
import {
  type AgentSessionAccountHome,
  isLegacyAgentSessionAccountHome
} from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type {
  AgentModelCatalogConfiguredChoice,
  AgentModelCatalogListing
} from './agent-model-catalog-entry'
import type { AgentModelCatalogStore } from './agent-model-catalog-store'

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
  workspaceMayOverrideDefaultModel?: (input: {
    agent: string
    workspacePath: string
    accountHomePath: string | null
  }) => Promise<boolean>
}

/** Claude and Codex pickers show the account's default everywhere, as the references do; the CLI
 *  still applies a project's own settings at launch and the chat then reports what it ran. */
export function agentModelCatalogDefaultFollowsAccount(agent: string): boolean {
  return independentAgentModelCatalog(agent)
}

export async function workspaceKeepsListedDefault(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  accountHomePath: string | null
): Promise<boolean> {
  if (workspacePath === undefined || agentModelCatalogDefaultFollowsAccount(agent)) {
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
  if (!agentModelCatalogDefaultFollowsAccount(record.provider)) {
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
  }
  if (
    current() &&
    deps.getRecord(record.sessionId)?.lease.runtimeFence === record.lease.runtimeFence
  ) {
    deps.store.recordConfiguredDefault(fingerprint, choice, source)
  }
}

/** The workspace's own settings, checked once per refresh for every reader sharing it; null
 *  when the read failed, which leaves each binding's conservative projection. */
export function agentModelCatalogListedDefault(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  workspacePath: string | null | undefined,
  home: AgentSessionAccountHome | null
): Promise<boolean | null> {
  const accountHomePath = home && isLegacyAgentSessionAccountHome(home) ? home.path : null
  return workspaceKeepsListedDefault(deps, agent, workspacePath, accountHomePath).catch(() => null)
}
