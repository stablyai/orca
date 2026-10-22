import { homedir } from 'node:os'
import type {
  AgentSessionAccountHome,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type {
  AgentModelCatalogService,
  AgentModelCatalogServiceDeps
} from './agent-model-catalog-service-contract'
import { agentModelCatalogScopeFingerprint } from './agent-model-catalog-fingerprint'
import {
  independentAgentModelCatalog,
  type AgentModelCatalogResolvedProbe
} from './agent-model-catalog-discovery'
import { sessionWorkspacePath } from './agent-model-catalog-workspace'

/** Launch configuration determines discovery scope; a chat's choices never participate. */
export async function resolveAgentModelCatalogScope(
  deps: AgentModelCatalogServiceDeps,
  params: Parameters<AgentModelCatalogService['read']>[0],
  record: AgentSessionRecord | undefined,
  base: string,
  home: AgentSessionAccountHome | null
): Promise<{
  base: string
  fingerprint: string
  exact: boolean
  cwd?: string
  resolved?: AgentModelCatalogResolvedProbe
} | null> {
  if (!independentAgentModelCatalog(params.agent) || !home) {
    return { base, fingerprint: base, exact: false }
  }
  if (record && !isNativeLocalLocation(record.location)) {
    return { base, fingerprint: base, exact: false }
  }
  const probe = deps.probes?.[params.agent]
  if (params.legacy) {
    const resolved = params.savedOnly ? null : await probe?.resolveLegacy?.(home).catch(() => null)
    return {
      base,
      fingerprint: agentModelCatalogScopeFingerprint(base, 'legacy-account'),
      exact: false,
      ...(resolved ? { resolved } : {})
    }
  }
  const cwd =
    params.workspacePath === null
      ? null
      : (params.workspacePath ?? (record ? await sessionWorkspacePath(deps, record) : homedir()))
  if (!cwd) {
    return { base, fingerprint: base, exact: false }
  }
  const resolution = params.savedOnly
    ? probe?.resolve?.(home, cwd, true)
    : probe?.resolve?.(home, cwd)
  const resolved = await resolution?.catch(() => null)
  if (probe?.resolve && !resolved) {
    return null
  }
  return {
    base,
    fingerprint: agentModelCatalogScopeFingerprint(base, cwd, resolved?.identity),
    exact: true,
    cwd,
    ...(resolved ? { resolved } : {})
  }
}
