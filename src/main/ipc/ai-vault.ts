import { app, ipcMain } from 'electron'
import {
  configureAiVaultSessionSources,
  listAiVaultSessions as listCachedLocalAiVaultSessions,
  resetAiVaultSessionListCacheForTests,
  type AiVaultSessionSources
} from '../ai-vault/cached-session-list'
import { deleteAiVaultSession, registerAiVaultDeleteHandler } from './ai-vault-delete'
import { listAiVaultSubagentSessions } from './ai-vault-subagent-list'
import {
  aiVaultScanIssueResult,
  cancelledAiVaultListResult
} from '../ai-vault/session-list-results'
import { AiVaultScanCoordinator } from '../ai-vault/ai-vault-scan-coordinator'
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
import { LOCAL_EXECUTION_HOST_ID, requestedExecutionHostScope } from '../../shared/execution-host'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'
import type { RuntimeAiVaultHostInfo, RuntimeAiVaultScanner } from './ai-vault-runtime-scan'
import {
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
import { projectStructuredAiVaultSessions } from '../ai-vault/structured-session-ownership'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type {
  AiVaultRankSessionsArgs,
  AiVaultRankSessionsResult
} from '../../shared/ai-vault-session-ai-query'
import type {
  AiVaultSearchSessionsArgs,
  AiVaultSearchSessionsResult
} from '../../shared/ai-vault-session-search-scope'
import {
  clearListedAiVaultSessions,
  rankListedAiVaultSessions,
  rememberListedAiVaultSessions,
  searchListedAiVaultSessions,
  syncDurableSessionIndex
} from '../ai-vault/listed-session-search'
import { scanAiVaultSessionsByHostScope } from '../ai-vault/session-host-scan'

type AiVaultHandlerOptions = AiVaultSessionSources &
  AiVaultResumeHandlerOptions & {
    getActiveRuntimeAiVaultHostInfos?: () => readonly RuntimeAiVaultHostInfo[]
    scanRuntimeAiVaultSessions?: RuntimeAiVaultScanner
    resolveRuntimeAiVaultSessionTitles?: RuntimeAiVaultSessionTitleResolver
    getSettings?: () => GlobalSettings
    getRepo?: (repoId: string) => Repo | undefined
    getWslDistroForRepo?: (repo: Repo) => string | undefined
  }

let scanCoordinator = new AiVaultScanCoordinator()
let handlerOptions: AiVaultHandlerOptions = {}
const listCancellations = createSenderScopedRequestCancellations()
// Shared by the IPC registration and the test internals: a delete must drop
// the multi-host leg cache, which this module owns the only caller of.
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
  // Scope paths change the result set, so they must be part of the cache key.
  // A scanner consumes at most 64 paths, so smaller equivalent workspace sets
  // can share a snapshot regardless of which worktree was selected first.
  const scopePaths = args?.scopePaths ?? []
  const key = JSON.stringify({
    scopePaths:
      scopePaths.length <= AI_VAULT_SCOPE_PATHS_MAX_COUNT
        ? [...new Set(scopePaths)].sort()
        : scopePaths,
    executionHostScope
  })
  const depth = requestedAiVaultSessionDepth(args)
  const scanKey = JSON.stringify({ key, depth })
  // Why: every renderer request carries its own cancellation signal, so
  // coalescing has to survive them — the coordinator hands all same-key callers
  // one scan and only aborts it once every one of them has cancelled.
  const result = await scanCoordinator.run({
    key: scanKey,
    force: args?.force,
    signal: options.signal,
    start: (scanSignal) => {
      const scan = () =>
        scanAiVaultSessionsByHostScope(args, executionHostScope, scanSignal, key, {
          getActiveRuntimeAiVaultHostInfos: handlerOptions.getActiveRuntimeAiVaultHostInfos,
          scanRuntimeAiVaultSessions: handlerOptions.scanRuntimeAiVaultSessions,
          scanLocal: scanLocalAiVaultSessionsAsIssue
        })
      if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
        return scan()
      }
      return scanHostLegWithCache({
        cacheKey: key,
        depth,
        scopePaths,
        force: args?.force === true,
        scan
      })
    }
  })
  rememberListedAiVaultSessions(result.sessions)
  return result
}

// Why: the SSH legs already degrade to an issue row so one bad host can't take
// the shared Promise.all down; the local leg can throw too (parse-cache load,
// WSL home resolution, scanner service supervision) and would otherwise discard
// every host's sessions under 'all', or replace the list with a raw error string
// under single-host scope.
async function scanLocalAiVaultSessionsAsIssue(
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined
): Promise<AiVaultListResult> {
  try {
    return await scanLocalAiVaultSessions(args, signal)
  } catch (error) {
    if (isAiVaultScanCancelledError(error)) {
      throw error
    }
    // Raw supervision text ("restart circuit is open") means nothing to a user,
    // so the row carries actionable copy and the log keeps the original.
    const raw = error instanceof Error ? error.message : 'Local session scan failed.'
    console.error('[ai-vault] local session scan failed:', raw)
    return aiVaultScanIssueResult({
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      path: 'this computer',
      message: describeAiVaultScanError(raw)
    })
  }
}

async function scanLocalAiVaultSessions(
  args?: AiVaultListArgs,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  // Why: the shared cache module owns codex-home/WSL sourcing and the local
  // scan cache, so the desktop IPC path and the runtime RPC method (mobile)
  // share one cache instance and one source of managed-Codex homes.
  const result = await listCachedLocalAiVaultSessions(
    {
      limit: args?.limit,
      unlimited: args?.unlimited,
      force: args?.force,
      scopePaths: args?.scopePaths
    },
    { signal }
  )
  // Why: FTS/rg indexing is best-effort. A userData/Electron miss must not
  // replace a completed local scan with an issue row (SSH use case too).
  try {
    syncDurableSessionIndex(result)
  } catch (error) {
    console.warn('[ai-vault] Failed to update session search index:', error)
  }
  return result
}

export function registerAiVaultHandlers(options: AiVaultHandlerOptions = {}): void {
  handlerOptions = options
  // Why: configure the SAME shared cache module the runtime RPC method uses so
  // there is exactly one cache instance and neither caller drops codex-home or
  // WSL injection. The runtime also configures these sources from its deps
  // (serve-mode reachable); this desktop path supplies the same source.
  configureAiVaultSessionSources(options)
  ipcMain.handle('aiVault:listSessions', async (event, args?: AiVaultListArgs) => {
    const requestToken =
      typeof args?.requestToken === 'string' && args.requestToken.length <= 128
        ? args.requestToken
        : undefined
    const controller = listCancellations.begin(event, requestToken)
    try {
      await handlerOptions.ensureStructuredSessionOwnership?.()
      const result = await listAiVaultSessions(args, { signal: controller?.signal })
      return projectStructuredAiVaultSessions(result, true)
    } catch (error) {
      // Why: superseding a scan is normal control flow, but Electron logs every
      // rejected handler — report it as a result so the log stays truthful.
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
  ipcMain.handle(
    'aiVault:rankSessions',
    (_event, args: AiVaultRankSessionsArgs): Promise<AiVaultRankSessionsResult> =>
      rankListedAiVaultSessions(args, handlerOptions)
  )
  ipcMain.handle(
    'aiVault:searchSessions',
    (_event, args: AiVaultSearchSessionsArgs): Promise<AiVaultSearchSessionsResult> =>
      searchListedAiVaultSessions(args)
  )
  // macOS app activation skips DOM focus events, so emit the refresh signal here.
  app.on('browser-window-focus', (_event, window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('aiVault:windowFocused')
    }
  })
}

function resetAiVaultCacheForTests(): void {
  resetAiVaultHostLegCacheForTests()
  scanCoordinator = new AiVaultScanCoordinator()
  handlerOptions = {}
  clearListedAiVaultSessions()
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
