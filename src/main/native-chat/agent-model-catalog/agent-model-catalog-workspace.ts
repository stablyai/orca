import type {
  AgentSessionAccountHome,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentModelCatalogBinding } from './agent-model-catalog-snapshot'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type { AgentModelCatalogConfiguredChoice } from './agent-model-catalog-entry'
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
  current: () => boolean
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
  if (
    current() &&
    deps.getRecord(record.sessionId)?.lease.runtimeFence === record.lease.runtimeFence
  ) {
    deps.store.recordConfiguredDefault(fingerprint, choice)
  }
}

/** Default provenance belongs to the resolved binding and the operation projecting it. */
export async function projectAgentModelCatalogDefault(
  deps: AgentModelCatalogWorkspaceDeps,
  agent: string,
  bound: AgentModelCatalogBinding,
  home: AgentSessionAccountHome | null,
  current: () => boolean
): Promise<void> {
  const accountHomePath = home && isLegacyAgentSessionAccountHome(home) ? home.path : null
  const path =
    bound.workspacePath === null && independentAgentModelCatalog(agent)
      ? undefined
      : bound.workspacePath
  try {
    const keepDefault = await workspaceKeepsListedDefault(deps, agent, path, accountHomePath)
    if (current()) {
      bound.keepDefault = keepDefault
    }
  } catch {
    /* A failed provenance read leaves the binding's conservative projection. */
  }
}
