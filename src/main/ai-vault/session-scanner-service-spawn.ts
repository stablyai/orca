import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { AiVaultListResult, AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { withSpan, type ActiveSpan } from '../observability/tracer'
import type {
  ReadAiVaultFirstUserPromptArgs,
  ReadAiVaultFirstUserPromptResult
} from './session-first-user-prompt-read'
import { getSessionParseCachePersistenceOptions } from './session-parse-cache-persistence'
import { buildAiVaultServiceEnv } from './session-scanner-service-env'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import { getAiVaultServiceEntryPath } from './session-scanner-service-entry-path'
import { lowerAiVaultServicePriority } from './session-scanner-service-priority'
import type { AiVaultServiceSubagentRequest } from './session-scanner-service-protocol'
import type { DiscoveryStats } from './session-scanner-types'
import type { AiVaultWorkerScanOptions } from './session-scanner-worker-protocol'

// libuv defaults to 4 threads: every local fs.stat/readdir the scanner issues
// (not just UNC ones — those go through the WSL gate instead) shares that
// pool, serializing discovery 4-wide no matter how wide the JS-side batching
// is. Set at the fork site, not in buildAiVaultServiceEnv: the allowlist must
// keep refusing an ambient UV_THREADPOOL_SIZE, and env: on fork() replaces
// rather than merges, so this can't leak into the parent process.
const AI_VAULT_SERVICE_UV_THREADPOOL_SIZE = 16

export function spawnAiVaultServiceProcess(): ChildProcess {
  const entryPath = getAiVaultServiceEntryPath()
  if (!existsSync(entryPath)) {
    throw new Error(`AI Vault service entry not found: ${entryPath}`)
  }
  const child = fork(entryPath, [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: ['--max-old-space-size=384'],
    env: {
      ...buildAiVaultServiceEnv(),
      UV_THREADPOOL_SIZE: String(AI_VAULT_SERVICE_UV_THREADPOOL_SIZE)
    },
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
    init: { sessionParseCache: getSessionParseCachePersistenceOptions() },
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
      discoveryStats: DiscoveryStats
    }>({ type: 'request', operation: 'scan', options }, signal)
    span.setAttribute('serviceDurationMs', value.durationMs)
    span.setAttribute('sessions', value.result.sessions.length)
    stampDiscoverySpanAttributes(span, value.discoveryStats)
    return value.result
  })
}

// The forked child never installs a tracer sink (it only calls
// scanAiVaultSessions in-process), so this is the one place a slow-discovery
// regression becomes visible in main.trace.ndjson without instrumenting the
// child itself.
export function stampDiscoverySpanAttributes(span: ActiveSpan, stats: DiscoveryStats): void {
  const uncRoots = stats.roots.filter((root) => root.isUncPath)
  span.setAttribute('discoveryMs', Math.round(stats.totalMs))
  span.setAttribute('discoveryRootCount', stats.roots.length)
  span.setAttribute('discoveryUncRootCount', uncRoots.length)
  span.setAttribute(
    'discoveryUncElapsedMs',
    Math.round(uncRoots.reduce((sum, root) => sum + root.elapsedMs, 0))
  )
  span.setAttribute('discoveryErroredRootCount', stats.roots.filter((root) => root.errored).length)
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

export function invalidateAiVaultServiceCache(paths: string[]): Promise<void> {
  return sharedClient?.invalidate(paths) ?? Promise.resolve()
}

export function resetAiVaultScannerServiceForTests(): void {
  sharedClient?.dispose()
  sharedClient = null
}
