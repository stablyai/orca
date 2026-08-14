import { homedir } from 'node:os'
import { AI_VAULT_SCOPE_PATHS_MAX_COUNT, type AiVaultListResult } from '../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import {
  AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT,
  type AiVaultSessionTitleRequest,
  type AiVaultSessionTitlesResult
} from '../shared/ai-vault-session-title'
import {
  SSH_AI_VAULT_LIST_LIMIT_MAX,
  SSH_AI_VAULT_LIST_SESSIONS_METHOD,
  SSH_AI_VAULT_RESOLVE_SESSION_TITLES_METHOD,
  SSH_AI_VAULT_SCOPE_PATH_MAX_LENGTH,
  type SshAiVaultRelayListParams
} from '../shared/ssh-ai-vault-relay'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { parseUnameToRelayPlatform } from '../main/ssh/relay-protocol'
import { relayLogLine } from './relay-diagnostic-log'
import type { RelayDispatcher } from './dispatcher'
import { AiVaultScanCoordinator } from '../main/ai-vault/ai-vault-scan-coordinator'
import type { RelayAiVaultServiceApi } from './ai-vault-service-client-state'

type AiVaultHandlerOptions = {
  remoteHome?: string
  hostPlatform?: RemoteHostPlatform
  service?: RelayAiVaultServiceApi
}

export class AiVaultHandler {
  private readonly remoteHome: string
  private readonly scanCoordinator = new AiVaultScanCoordinator()

  constructor(dispatcher: RelayDispatcher, options: AiVaultHandlerOptions = {}) {
    this.remoteHome = options.remoteHome ?? homedir()
    const hostPlatform = options.hostPlatform ?? currentRelayHostPlatform()
    // Why: an OS/arch this build has no path flavor for must not abort relay
    // startup — leaving the method unregistered soft-disables the feature and
    // the host falls back to its own SSH filesystem scan.
    if (!hostPlatform) {
      relayLogLine(
        `[relay] Agent Session History disabled: unsupported platform ${process.platform}-${process.arch}`
      )
      return
    }
    // Why: same reasoning as an unsupported platform. Throwing here would take
    // relay startup — and every PTY on the host — down over a Vault wiring bug.
    const service = options.service
    if (!service) {
      relayLogLine('[relay] Agent Session History disabled: service unavailable')
      return
    }
    dispatcher.onRequest(SSH_AI_VAULT_LIST_SESSIONS_METHOD, (params, context) =>
      this.listSessions(service, params, context.signal)
    )
    dispatcher.onRequest(SSH_AI_VAULT_RESOLVE_SESSION_TITLES_METHOD, (params, context) =>
      this.resolveSessionTitles(service, params, context.signal)
    )
  }

  private async resolveSessionTitles(
    service: RelayAiVaultServiceApi,
    rawParams: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    try {
      return await service.resolveSessionTitles(normalizeTitleRequests(rawParams.requests), signal)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }
      // Why: titles are decoration. Degrade like an unresolvable title instead of
      // failing the RPC, which would surface a raw error on every list row.
      relayLogLine(
        `[relay-ai-vault-service] title resolution unavailable: ${error instanceof Error ? error.message : String(error)}`
      )
      return { titles: [] }
    }
  }

  private async listSessions(
    service: RelayAiVaultServiceApi,
    rawParams: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<AiVaultListResult> {
    const params = normalizeSshAiVaultRelayListParams(rawParams)
    let result: AiVaultListResult
    try {
      result = await this.scanCoordinator.run({
        key: JSON.stringify({
          limit: params.limit,
          unlimited: params.unlimited,
          scopePaths: params.scopePaths,
          scopePathsTruncated: params.scopePathsTruncated
        }),
        force: params.force,
        signal,
        start: (scanSignal) => service.listSessions(params, scanSignal)
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }
      result = {
        sessions: [],
        scannedAt: new Date().toISOString(),
        issues: [
          {
            executionHostId: LOCAL_EXECUTION_HOST_ID,
            agent: 'codex',
            kind: 'host',
            path: this.remoteHome,
            message: `Agent Session History service unavailable: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      }
    }
    if (!params.scopePathsTruncated) {
      return result
    }
    return {
      ...result,
      issues: [
        ...result.issues,
        {
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          agent: 'codex',
          kind: 'scope',
          path: this.remoteHome,
          message: `Only the first ${AI_VAULT_SCOPE_PATHS_MAX_COUNT} project paths were scanned.`
        }
      ]
    }
  }
}

function normalizeTitleRequests(raw: unknown): AiVaultSessionTitleRequest[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const requests: AiVaultSessionTitleRequest[] = []
  for (const value of raw.slice(0, AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT)) {
    if (!value || typeof value !== 'object') {
      continue
    }
    const record = value as Record<string, unknown>
    const agent = record.agent
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
    const transcriptPath =
      typeof record.transcriptPath === 'string' ? record.transcriptPath.trim() : ''
    if (
      (agent !== 'claude' && agent !== 'codex') ||
      !sessionId ||
      sessionId.length > 512 ||
      !transcriptPath ||
      transcriptPath.length > 32_768
    ) {
      continue
    }
    requests.push({ agent, sessionId, transcriptPath })
  }
  return requests
}

export function normalizeSshAiVaultRelayListParams(
  params: Record<string, unknown>
): SshAiVaultRelayListParams {
  const rawLimit = params.limit
  const unlimited = params.unlimited === true
  const limit =
    !unlimited && typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), SSH_AI_VAULT_LIST_LIMIT_MAX)
      : undefined
  const scopePaths = Array.isArray(params.scopePaths)
    ? params.scopePaths
        .slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT)
        .filter(
          (path): path is string =>
            typeof path === 'string' &&
            path.trim().length > 0 &&
            path.length <= SSH_AI_VAULT_SCOPE_PATH_MAX_LENGTH
        )
    : undefined
  const scopePathsTruncated =
    params.scopePathsTruncated === true ||
    (Array.isArray(params.scopePaths) && params.scopePaths.length > AI_VAULT_SCOPE_PATHS_MAX_COUNT)
  return {
    ...(unlimited ? { unlimited: true } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(params.force === true ? { force: true } : {}),
    ...(scopePaths === undefined ? {} : { scopePaths }),
    ...(scopePathsTruncated ? { scopePathsTruncated: true } : {})
  }
}

function currentRelayHostPlatform(): RemoteHostPlatform | null {
  const relayPlatform = parseUnameToRelayPlatform(process.platform, process.arch)
  return relayPlatform ? getRemoteHostPlatform(relayPlatform) : null
}
