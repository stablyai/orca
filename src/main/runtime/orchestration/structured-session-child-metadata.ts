import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { isStructuredAgentId } from '../../../shared/agent-session-provider-handle-encoding'
import { parseRoutableExecutionHostId } from '../../../shared/execution-host'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type {
  OrchestrationChildExecutionHost,
  OrchestrationChildMetadata
} from '../../../shared/orchestration-session-children'
import { FederationAttachStartParams } from '../../../shared/rpc-contract/orchestration-federation-start-params'
import {
  readWorkerTerminalHostScope,
  type WorkerTerminalHostScopeRead
} from '../../../shared/worker-terminal-host-scope'
import type { DispatchContextRow, FederatedDispatchRow, WorkerDispatchRow } from './types'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'

const launchAgent = FederationAttachStartParams.pick({ agent: true })

export function structuredSessionChildMetadata(args: {
  dispatch: DispatchContextRow
  worker: WorkerDispatchRow | undefined
  resource: WorkerTerminalResourceRow | undefined
  federation: FederatedDispatchRow | undefined
  session: AgentSessionConversationView | null
}): OrchestrationChildMetadata | undefined {
  const scopes = [args.dispatch.host_scope, args.resource?.host_scope]
    .map(readWorkerTerminalHostScope)
    .filter((scope) => scope.kind !== 'absent')
  const hosts = scopes.map(scopeHost)
  const scopeHostKnown = hosts[0]
  const scopesAgree = hosts.every(
    (host) => host !== undefined && JSON.stringify(host) === JSON.stringify(scopeHostKnown)
  )
  const session = scopesAgree ? args.session : null
  const sessionHost = session ? recordHost(session) : undefined
  const sessionMatchesHost =
    sessionHost !== undefined &&
    (scopes.length === 0 || JSON.stringify(sessionHost) === JSON.stringify(scopeHostKnown))
  const agent =
    (sessionMatchesHost ? knownAgent(session?.provider) : undefined) ??
    recordedLaunchAgent(args.worker?.start_options)
  const executionHost: OrchestrationChildExecutionHost | undefined = args.federation
    ? args.federation.environment_id.trim()
      ? {
          kind: 'environment',
          environmentId: args.federation.environment_id,
          ...(args.federation.environment_name.trim()
            ? { label: args.federation.environment_name.trim() }
            : {})
        }
      : undefined
    : scopesAgree
      ? (scopeHostKnown ??
        sessionHost ??
        (scopes.length === 0 && args.resource ? { kind: 'local' } : undefined))
      : undefined
  return agent || executionHost
    ? {
        ...(agent ? { agent } : {}),
        ...(executionHost ? { executionHost } : {})
      }
    : undefined
}

function knownAgent(value: unknown): string | undefined {
  return isStructuredAgentId(value) && value !== 'unknown' ? value : undefined
}

function recordedLaunchAgent(value: string | undefined): string | undefined {
  try {
    const parsed = launchAgent.safeParse(JSON.parse(value ?? '{}'))
    return parsed.success && isTuiAgent(parsed.data.agent) ? parsed.data.agent : undefined
  } catch {
    return undefined
  }
}

function scopeHost(
  scope: WorkerTerminalHostScopeRead
): OrchestrationChildExecutionHost | undefined {
  if (scope.kind !== 'local' && scope.kind !== 'remote') {
    return undefined
  }
  switch (scope.scope?.kind) {
    case 'local':
      return { kind: 'local' }
    case 'wsl':
      return scope.scope.distro.trim() ? { kind: 'wsl', distro: scope.scope.distro } : undefined
    case 'ssh':
      return scope.scope.targetId.trim()
        ? { kind: 'ssh', targetId: scope.scope.targetId }
        : undefined
    case undefined:
      return undefined
  }
}

function recordHost(
  record: AgentSessionConversationView
): OrchestrationChildExecutionHost | undefined {
  const host = parseRoutableExecutionHostId(record.location.executionHostId)
  if (host?.kind === 'local') {
    return record.location.wslDistro
      ? { kind: 'wsl', distro: record.location.wslDistro }
      : { kind: 'local' }
  }
  if (record.location.wslDistro) {
    return undefined
  }
  if (host?.kind === 'ssh') {
    return { kind: 'ssh', targetId: host.targetId }
  }
  return host?.kind === 'runtime'
    ? { kind: 'environment', environmentId: host.environmentId }
    : undefined
}
