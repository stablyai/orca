import { independentAgentModelCatalog } from '../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'
import type { AgentModelCatalogServiceDeps } from './agent-model-catalog-service-contract'
import type { AgentModelCatalogLaunch } from './agent-model-catalog-refresh'
import { recordCatalogKey } from './agent-model-catalog-fingerprint'
import { newChatCatalogKey } from './agent-model-catalog-prewarm'
import { catalogFolder, sessionWorkspacePath } from './agent-model-catalog-workspace'

export async function resolveAgentModelCatalogAccount(
  deps: AgentModelCatalogServiceDeps,
  launch: AgentModelCatalogLaunch,
  current: () => boolean
) {
  const { agent, records } = launch
  const { record, scoped } = records
  const workspacePath =
    launch.inSessionWorkspace ||
    (record &&
      launch.workspacePath === undefined &&
      !launch.legacy &&
      (independentAgentModelCatalog(agent) || deps.agentReadsProjectModelConfig?.(agent) === true))
      ? record
        ? await sessionWorkspacePath(deps, record)
        : null
      : launch.workspacePath
  if (!current()) {
    return null
  }
  const folder = await catalogFolder(deps, agent, workspacePath, scoped)
  if (!current()) {
    return null
  }
  const account = scoped
    ? recordCatalogKey(scoped, folder)
    : await newChatCatalogKey(deps, agent, folder)
  if (!current() || !account) {
    return null
  }
  return {
    record,
    scoped,
    workspacePath,
    folder,
    base: account.fingerprint,
    probeHome: account.accountHome
  }
}
