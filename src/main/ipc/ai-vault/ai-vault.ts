import { scanRemoteLeg } from './ai-vault-remote-scan-observation'
import {
  forwardRowInterest,
  rowsAreObserved
} from '../../ai-vault/scan-lifecycle/ai-vault-row-interest'
import type { AiVaultRowDelta, AiVaultScanRows } from '../../../shared/ai-vault-scan-rows'
import { registerAiVaultListHandler } from './ai-vault-list-handler'
import {
  captureRuntimeAiVaultProjectionDependency,
  type AiVaultProjectionDependency
} from './ai-vault-projection-dependency'
import { app, ipcMain } from 'electron'
import { configureAiVaultSessionSources } from '../../ai-vault/discovery/ai-vault-scan-roots'
import {
  listAiVaultSessions as listCachedLocalAiVaultSessions,
  AiVaultLocalScanError,
  resetAiVaultSessionListCacheForTests
} from '../../ai-vault/listing/cached-session-list'
import type { AiVaultSessionSources } from '../../ai-vault/discovery/ai-vault-scan-roots'
import { deleteAiVaultSession, registerAiVaultDeleteHandler } from './ai-vault-delete'
import { listAiVaultSubagentSessions } from './ai-vault-subagent-list'
import {
  aiVaultScanIssueResult,
  mergeAiVaultListResults
} from '../../ai-vault/listing/session-list-results'
import type { AiVaultDeleteSessionArgs } from '../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import { classifyAiVaultScanError } from '../../../shared/ai-vault/scanning/ai-vault-scan-error-message'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  isAiVaultScanCancelledError,
  type AiVaultFirstUserPromptArgs,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSubagentListArgs,
  type AiVaultSubagentListResult
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { handleAiVaultGetFirstUserPrompt } from '../../ai-vault/prompts/session-first-user-prompt-handler'
import { registerAiVaultResumeHandler, type AiVaultResumeHandlerOptions } from './ai-vault-resume'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  requestedExecutionHostScope,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { discoverAiVaultHosts, type AiVaultHostDiscoveryResult } from './ai-vault-host-discovery'
import {
  scanRuntimeAiVaultSessions,
  type RuntimeAiVaultHostInfo,
  type RuntimeAiVaultScanner
} from '../../ai-vault/runtime-hosts/ai-vault-runtime-scan'
import {
  createAiVaultListScanCoordinator,
  invalidateAiVaultHostLegCache,
  resetAiVaultHostLegCacheForTests,
  scanHostLegWithCache
} from './ai-vault-host-leg-cache'
import { requestedAiVaultSessionDepth } from '../../../shared/ai-vault/scanning/ai-vault-session-depth'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../../shared/ai-vault/contracts/ai-vault-session-title'
import {
  resolveAiVaultSessionTitlesByHost,
  type RuntimeAiVaultSessionTitleResolver
} from './ai-vault-session-title-routing'
import { allHostsRuntimeScanTimeoutMs } from './ai-vault-all-host-timeouts'
import { registerAiVaultScanProgressBroadcast } from './ai-vault-scan-progress-broadcast'

type AiVaultHandlerOptions = AiVaultSessionSources &
  AiVaultResumeHandlerOptions & {
    getUserDataPath?: () => string
    getActiveRuntimeAiVaultHostInfos?: () => readonly RuntimeAiVaultHostInfo[]
    scanRuntimeAiVaultSessions?: RuntimeAiVaultScanner
    resolveRuntimeAiVaultSessionTitles?: RuntimeAiVaultSessionTitleResolver
  }

type AiVaultScanHostScope =
  | { scope: ExecutionHostId }
  | { scope: 'all'; runtimeHosts: AiVaultHostDiscoveryResult<RuntimeAiVaultHostInfo> }

let scanCoordinator = createAiVaultListScanCoordinator()
let handlerOptions: AiVaultHandlerOptions = {}
// Keep IPC and test deletion wired to this module's multi-host cache.
const aiVaultDeleteDeps = {
  invalidateMultiHostListCache: invalidateAiVaultHostLegCache
}

const resolveAiVaultSessionTitles = (
  args: AiVaultSessionTitlesArgs
): Promise<AiVaultSessionTitlesResult> =>
  resolveAiVaultSessionTitlesByHost(args, handlerOptions.resolveRuntimeAiVaultSessionTitles)

async function listAiVaultSessions(
  args?: AiVaultListArgs,
  options: { signal?: AbortSignal; observeRows?: (rows: AiVaultScanRows) => void } = {}
): Promise<AiVaultListResult> {
  const executionHostScope = requestedExecutionHostScope(args?.executionHostScope)
  const hostScope: AiVaultScanHostScope =
    executionHostScope === 'all'
      ? { scope: executionHostScope, runtimeHosts: getActiveRuntimeAiVaultHostInfosResult() }
      : { scope: executionHostScope }
  const parsedHost = parseRoutableExecutionHostId(executionHostScope)
  const dependency = captureRuntimeAiVaultProjectionDependency(
    hostScope.scope === 'all'
      ? hostScope.runtimeHosts.hostInfos.map((host) => host.environmentId)
      : parsedHost?.kind === 'runtime'
        ? [parsedHost.environmentId]
        : [],
    handlerOptions.getUserDataPath
  )
  // Canonicalize bounded workspace sets so equivalent scopes share a scan.
  const scopePaths = args?.scopePaths ?? []
  const key = JSON.stringify({
    scopePaths:
      scopePaths.length <= AI_VAULT_SCOPE_PATHS_MAX_COUNT
        ? [...new Set(scopePaths)].sort()
        : scopePaths,
    executionHostScope,
    includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions === true,
    ...(args?.scopeOnly === true ? { scopeOnly: true } : {})
  })
  const depth = requestedAiVaultSessionDepth(args)
  const afterFingerprint =
    parseRoutableExecutionHostId(executionHostScope)?.kind === 'runtime'
      ? args?.afterFingerprint
      : undefined
  // Why: every renderer request carries its own cancellation signal, so
  // coalescing has to survive them — the coordinator hands all same-key callers
  // one scan and only aborts it once every one of them has cancelled.
  return scanCoordinator
    .run({
      key: JSON.stringify({ key, depth, afterFingerprint, projection: dependency.key }),
      force: args?.force,
      aggregate: true,
      observeRows: options.observeRows,
      signal: options.signal,
      start: (scanSignal, _scanId, publish) => {
        const scan = () =>
          scanAiVaultSessionsByHostScope(args, hostScope, scanSignal, key, dependency, publish)
        if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
          return scan()
        }
        return scanHostLegWithCache({
          cacheKey: key,
          dependency,
          depth,
          scopePaths,
          force: args?.force === true,
          afterFingerprint,
          scan
        })
      }
    })
    .finally(dependency.release)
}

async function scanAiVaultSessionsByHostScope(
  args: AiVaultListArgs | undefined,
  hostScope: AiVaultScanHostScope,
  signal?: AbortSignal,
  cacheKey = '',
  dependency?: AiVaultProjectionDependency,
  publish?: (delta: AiVaultRowDelta) => void
): Promise<AiVaultListResult> {
  const depth = requestedAiVaultSessionDepth(args)
  const scopePaths = args?.scopePaths ?? []
  if (hostScope.scope === LOCAL_EXECUTION_HOST_ID) {
    return scanLocalAiVaultSessionsAsIssue(args, signal, publish)
  }
  if (hostScope.scope === 'all') {
    const { runtimeHosts } = hostScope
    const runtimeResults = runtimeHosts.issue ? [runtimeHosts.issue] : []
    const scannedResults = await Promise.all([
      scanLocalAiVaultSessionsAsIssue(args, signal, publish),
      ...runtimeHosts.hostInfos.map((hostInfo) =>
        scanRemoteLeg(signal, hostInfo.executionHostId, args?.force === true, () =>
          scanHostLegWithCache({
            cacheKey: `${cacheKey}|${hostInfo.executionHostId}`,
            dependency: dependency?.forHost(hostInfo.environmentId),
            depth,
            scopePaths,
            force: args?.force === true,
            scan: () =>
              scanRuntimeAiVaultSessions({
                hostInfo,
                scanner: handlerOptions.scanRuntimeAiVaultSessions,
                listArgs: args ? { ...args, afterFingerprint: undefined } : undefined,
                options: {
                  signal,
                  timeoutMs: allHostsRuntimeScanTimeoutMs(hostInfo)
                }
              })
          })
        ).then((result) => {
          if (rowsAreObserved(publish)) {
            publish?.({ upserts: result.sessions, removed: [] })
          }
          return result
        })
      )
    ])
    return mergeAiVaultListResults(
      [...scannedResults, ...runtimeResults],
      args?.limit,
      args?.unlimited,
      scopePaths
    )
  }

  const executionHostScope = hostScope.scope
  const parsed = parseRoutableExecutionHostId(executionHostScope)
  if (parsed?.kind === 'runtime') {
    return scanRemoteLeg(signal, executionHostScope, args?.force === true, () =>
      scanRuntimeAiVaultSessions({
        hostInfo: {
          environmentId: parsed.environmentId,
          executionHostId: toRuntimeExecutionHostId(parsed.environmentId)
        },
        scanner: handlerOptions.scanRuntimeAiVaultSessions,
        listArgs: args,
        options: { signal }
      })
    )
  }

  return aiVaultScanIssueResult({
    executionHostId: executionHostScope,
    path: executionHostScope,
    message: 'Agent Session History is not available for this execution host.'
  })
}

export function getActiveRuntimeAiVaultHostInfosResult(): AiVaultHostDiscoveryResult<RuntimeAiVaultHostInfo> {
  return discoverAiVaultHosts(() => handlerOptions.getActiveRuntimeAiVaultHostInfos?.() ?? [], {
    path: 'runtime environments',
    fallbackMessage: 'Runtime hosts are unavailable.'
  })
}

// Like remote failures, local scanner/cache/WSL failures must degrade to issues without discarding healthy hosts.
async function scanLocalAiVaultSessionsAsIssue(
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined,
  publish?: (delta: AiVaultRowDelta) => void
): Promise<AiVaultListResult> {
  try {
    const observe = publish
      ? (rows: AiVaultScanRows) =>
          publish(rows.kind === 'delta' ? rows.delta : { upserts: [...rows.sessions], removed: [] })
      : undefined
    if (observe && publish) {
      forwardRowInterest(observe, publish)
    }
    return await listCachedLocalAiVaultSessions(args, { signal, observeRows: observe })
  } catch (error) {
    if (isAiVaultScanCancelledError(error)) {
      throw error
    }
    // Keep raw supervision details in logs; show an actionable host issue.
    const raw = error instanceof Error ? error.message : 'Local session scan failed.'
    console.error('[ai-vault] local session scan failed:', raw)
    const result = aiVaultScanIssueResult({
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      path: 'this computer',
      ...classifyAiVaultScanError(raw)
    })
    return error instanceof AiVaultLocalScanError ? { ...result, scanId: error.scanId } : result
  }
}

export function registerAiVaultHandlers(options: AiVaultHandlerOptions = {}): void {
  handlerOptions = options
  // Configure the same source/cache instance used by runtime RPC and headless serve.
  configureAiVaultSessionSources(options)
  registerAiVaultListHandler(listAiVaultSessions, () =>
    handlerOptions.ensureStructuredSessionOwnership?.()
  )
  ipcMain.handle(
    'aiVault:resolveSessionTitles',
    (_event, args: AiVaultSessionTitlesArgs): Promise<AiVaultSessionTitlesResult> =>
      resolveAiVaultSessionTitles(args)
  )
  registerAiVaultResumeHandler(options)
  ipcMain.handle(
    'aiVault:listSubagentSessions',
    (_event, args?: AiVaultSubagentListArgs): Promise<AiVaultSubagentListResult> =>
      listAiVaultSubagentSessions(args)
  )
  ipcMain.handle('aiVault:getFirstUserPrompt', (_event, args?: AiVaultFirstUserPromptArgs) =>
    handleAiVaultGetFirstUserPrompt(args)
  )
  registerAiVaultDeleteHandler(aiVaultDeleteDeps)
  registerAiVaultScanProgressBroadcast()
  // macOS app activation skips DOM focus events, so emit the refresh signal here.
  app.on('browser-window-focus', (_event, window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('aiVault:windowFocused')
    }
  })
}

function resetAiVaultCacheForTests(): void {
  resetAiVaultHostLegCacheForTests()
  scanCoordinator = createAiVaultListScanCoordinator()
  handlerOptions = {}
  // Keep tests isolated from the shared local-leg cache.
  resetAiVaultSessionListCacheForTests()
}

export const _internals = {
  listAiVaultSessions,
  resolveAiVaultSessionTitles,
  listAiVaultSubagentSessions,
  deleteAiVaultSession: (args?: AiVaultDeleteSessionArgs) =>
    deleteAiVaultSession(args, aiVaultDeleteDeps),
  resetAiVaultCacheForTests
}
