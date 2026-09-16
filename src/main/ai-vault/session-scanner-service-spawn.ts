import { localAiVaultScanRoots } from './cached-session-list'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import type { AiVaultListResult, AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { withSpan } from '../observability/tracer'
import type {
  ReadAiVaultFirstUserPromptArgs,
  ReadAiVaultFirstUserPromptResult
} from './session-first-user-prompt-read'
import { sessionSearchServiceInit } from '../ai-vault-search/session-search-service-init'
import { getSessionParseCachePersistenceOptions } from './session-parse-cache-persistence'
import { buildAiVaultServiceEnv } from './session-scanner-service-env'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import { getAiVaultServiceEntryPath } from './session-scanner-service-entry-path'
import { lowerAiVaultServicePriority } from './session-scanner-service-priority'
import type {
  AiVaultServiceSubagentRequest,
  AiVaultSessionSearchInit
} from './session-scanner-service-protocol'
import type { AiVaultWorkerScanOptions } from './session-scanner-worker-protocol'

export function spawnAiVaultServiceProcess(): ChildProcess {
  const entryPath = getAiVaultServiceEntryPath()
  if (!existsSync(entryPath)) {
    throw new Error(`AI Vault service entry not found: ${entryPath}`)
  }
  const child = fork(entryPath, [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: ['--max-old-space-size=384'],
    env: buildAiVaultServiceEnv(),
    ...(process.platform === 'win32' ? { windowsHide: true } : {})
  })
  lowerAiVaultServicePriority(child.pid)
  child.unref()
  return child
}

let sharedClient: AiVaultScannerServiceClient | null = null

function getSharedClient(): AiVaultScannerServiceClient {
  sharedClient ??= new AiVaultScannerServiceClient({
    processFactory: spawnAiVaultServiceProcess,
    resolveSessionSearchRoots: localAiVaultScanRoots,
    init: () => ({
      sessionParseCache: getSessionParseCachePersistenceOptions(),
      sessionSearch: sessionSearchServiceInit()
    }),
    onStderr: (text) => console.error('[ai-vault-service]', text.trimEnd())
  })
  return sharedClient
}

export function scanAiVaultSessionsInService(
  options: AiVaultWorkerScanOptions,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  return withSpan('aiVault.scan.service', async (span) => {
    const value = await getSharedClient().request<{
      result: AiVaultListResult
      durationMs: number
    }>({ type: 'request', operation: 'scan', options }, signal)
    span.setAttribute('serviceDurationMs', value.durationMs)
    span.setAttribute('sessions', value.result.sessions.length)
    return value.result
  })
}

export function resolveAiVaultSessionTitlesInService(
  requests: AiVaultSessionTitleRequest[],
  signal?: AbortSignal
): Promise<AiVaultSessionTitlesResult> {
  return getSharedClient().request({ type: 'request', operation: 'titles', requests }, signal)
}

export function listAiVaultSubagentSessionsInService(
  request: AiVaultServiceSubagentRequest,
  signal?: AbortSignal
): Promise<AiVaultSubagentListResult> {
  return getSharedClient().request({ type: 'request', operation: 'subagents', request }, signal)
}

export function readAiVaultFirstUserPromptInService(
  request: ReadAiVaultFirstUserPromptArgs,
  signal?: AbortSignal
): Promise<ReadAiVaultFirstUserPromptResult> {
  return getSharedClient().request({ type: 'request', operation: 'firstPrompt', request }, signal)
}

export function searchSessionsInService(
  request: AiVaultSearchRequest
): Promise<AiVaultSearchResponse> {
  return getSharedClient().request({ type: 'request', operation: 'searchSessions', request })
}

export function sessionSearchStatusInService(): Promise<AiVaultSearchStatus> {
  return getSharedClient().request({ type: 'request', operation: 'searchStatus' })
}

export function reconcileSessionSearchInService(): Promise<void> {
  return getSharedClient().request({ type: 'request', operation: 'searchReconcile' })
}

export function clearSessionSearchInService(): Promise<void> {
  return getSharedClient().request({ type: 'request', operation: 'searchClear' })
}

/** Boot and every settings change: push the policy and keep a child while the index runs. */
export function updateSessionSearchInService(init: AiVaultSessionSearchInit): void {
  getSharedClient().updateSessionSearch(init)
}

export function invalidateAiVaultServiceCache(paths: string[]): Promise<void> {
  return sharedClient?.invalidate(paths) ?? Promise.resolve()
}

/** A forced refresh is a deliberate user action, so it reopens the restart circuit. */
export function clearAiVaultServiceRestartCircuit(): void {
  sharedClient?.clearRestartCircuit()
}

export function resetAiVaultScannerServiceForTests(): void {
  sharedClient?.dispose()
  sharedClient = null
}
