import {
  captureRuntimeAiVaultProjectionDependency,
  type AiVaultProjectionDependency
} from './ai-vault-projection-dependency'
import { app, ipcMain } from 'electron'
import {
  configureAiVaultSessionSources,
  listAiVaultSessions as listCachedLocalAiVaultSessions,
  AiVaultLocalScanError,
  resetAiVaultSessionListCacheForTests,
  type AiVaultSessionSources
} from '../ai-vault/cached-session-list'
import { deleteAiVaultSession, registerAiVaultDeleteHandler } from './ai-vault-delete'
import { listAiVaultSubagentSessions } from './ai-vault-subagent-list'
import {
  aiVaultScanIssueResult,
  cancelledAiVaultListResult,
  mergeAiVaultListResults
} from '../ai-vault/session-list-results'
import type { AiVaultDeleteSessionArgs } from '../../shared/ai-vault-session-deletion'
import { describeAiVaultScanError } from '../../shared/ai-vault-scan-error-message'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  isAiVaultScanCancelledError,
  type AiVaultFirstUserPromptArgs,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSubagentListArgs,
  type AiVaultSubagentListResult
} from '../../shared/ai-vault-types'
import { handleAiVaultGetFirstUserPrompt } from '../ai-vault/session-first-user-prompt-handler'
import { registerAiVaultResumeHandler, type AiVaultResumeHandlerOptions } from './ai-vault-resume'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  requestedExecutionHostScope,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'
import { discoverAiVaultHosts, type AiVaultHostDiscoveryResult } from './ai-vault-host-discovery'
import {
  scanRuntimeAiVaultSessions,
  type RuntimeAiVaultHostInfo,
  type RuntimeAiVaultScanner
} from './ai-vault-runtime-scan'
import {
  createAiVaultListScanCoordinator,
  invalidateAiVaultHostLegCache,
  resetAiVaultHostLegCacheForTests,
  scanHostLegWithCache
} from './ai-vault-host-leg-cache'
import { requestedAiVaultSessionDepth } from '../../shared/ai-vault-session-depth'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import {
  resolveAiVaultSessionTitlesByHost,
  type RuntimeAiVaultSessionTitleResolver
} from './ai-vault-session-title-routing'
import {
  OPENS_EVERY_STRUCTURED_CHAT,
  projectStructuredAiVaultSessions
} from '../ai-vault/structured-session-ownership'
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
const listCancellations = createSenderScopedRequestCancellations()
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
  options: { signal?: AbortSignal } = {}
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
    includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions === true
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
      signal: options.signal,
      start: (scanSignal) => {
        const scan = () =>
          scanAiVaultSessionsByHostScope(args, hostScope, scanSignal, key, dependency)
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
  dependency?: AiVaultProjectionDependency
): Promise<AiVaultListResult> {
  const depth = requestedAiVaultSessionDepth(args)
  const scopePaths = args?.scopePaths ?? []
  if (hostScope.scope === LOCAL_EXECUTION_HOST_ID) {
    return scanLocalAiVaultSessionsAsIssue(args, signal)
  }
  if (hostScope.scope === 'all') {
    const { runtimeHosts } = hostScope
    const runtimeResults = runtimeHosts.issue ? [runtimeHosts.issue] : []
    const scannedResults = await Promise.all([
      scanLocalAiVaultSessionsAsIssue(args, signal),
      ...runtimeHosts.hostInfos.map((hostInfo) =>
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
    return scanRuntimeAiVaultSessions({
      hostInfo: {
        environmentId: parsed.environmentId,
        executionHostId: toRuntimeExecutionHostId(parsed.environmentId)
      },
      scanner: handlerOptions.scanRuntimeAiVaultSessions,
      listArgs: args,
      options: { signal }
    })
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
  signal: AbortSignal | undefined
): Promise<AiVaultListResult> {
  try {
    return await listCachedLocalAiVaultSessions(args, { signal })
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
      message: describeAiVaultScanError(raw)
    })
    return error instanceof AiVaultLocalScanError ? { ...result, scanId: error.scanId } : result
  }
}

export function registerAiVaultHandlers(options: AiVaultHandlerOptions = {}): void {
  handlerOptions = options
  // Configure the same source/cache instance used by runtime RPC and headless serve.
  configureAiVaultSessionSources(options)
  ipcMain.handle('aiVault:listSessions', async (event, args?: AiVaultListArgs) => {
    const requestToken =
      typeof args?.requestToken === 'string' && args.requestToken.length <= 128
        ? args.requestToken
        : undefined
    const controller = listCancellations.begin(event, requestToken)
    try {
      await handlerOptions.ensureStructuredSessionOwnership?.()
      const result = await listAiVaultSessions(args, {
        signal: controller?.signal
      })
      return projectStructuredAiVaultSessions(result, OPENS_EVERY_STRUCTURED_CHAT)
    } catch (error) {
      // Expected cancellation is a result so Electron does not log rejected IPC as an error.
      if (!isAiVaultScanCancelledError(error)) {
        throw error
      }
      return cancelledAiVaultListResult()
    } finally {
      listCancellations.finish(event, requestToken, controller)
    }
  })
  ipcMain.handle(
    'aiVault:resolveSessionTitles',
    (_event, args: AiVaultSessionTitlesArgs): Promise<AiVaultSessionTitlesResult> =>
      resolveAiVaultSessionTitles(args)
  )
  ipcMain.handle(
    'aiVault:cancelListSessions',
    (event, args: { requestToken?: string } | undefined): void => {
      if (typeof args?.requestToken === 'string' && args.requestToken.length <= 128) {
        listCancellations.cancel(event, args.requestToken)
      }
    }
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
