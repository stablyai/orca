// Whether a workspace's own config can replace the account's configured default model, for the
// catalog answer that names that default and for the default a no-pick chat teaches the catalog.

import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentModelCatalogConfiguredChoice } from './agent-model-catalog-entry'
import type { AgentModelCatalogServiceDeps } from './agent-model-catalog-service'

/** A named workspace keeps the listed default only when none of its own config can replace it. */
export async function workspaceKeepsListedDefault(
  deps: AgentModelCatalogServiceDeps,
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

/** A session launched with no model pick resolved its config scope's default model and effort;
 *  when that scope is the account's (a native workspace with no config of its own), they are the
 *  account's default, and a resolution naming no listed model retires the saved one. */
export async function recordConfiguredDefault(
  deps: AgentModelCatalogServiceDeps,
  record: AgentSessionRecord,
  fingerprint: string,
  choice: AgentModelCatalogConfiguredChoice | null
): Promise<void> {
  const accountHome = record.accountHome
  if (
    record.location.wslDistro !== null ||
    !deps.recordWorkspacePath ||
    !deps.workspaceMayOverrideDefaultModel
  ) {
    return
  }
  const workspacePath = await deps.recordWorkspacePath(record)
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
