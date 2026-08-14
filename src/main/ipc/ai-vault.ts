import { app, ipcMain } from 'electron'
import {
  configureAiVaultSessionSources,
  listAiVaultSessions as listCachedLocalAiVaultSessions,
  resetAiVaultSessionListCacheForTests,
  type AiVaultSessionSources
} from '../ai-vault/cached-session-list'
import { deleteAiVaultSession, registerAiVaultDeleteHandler } from './ai-vault-delete'
import { listAiVaultSubagentSessions } from './ai-vault-subagent-list'
import { cancelledAiVaultListResult } from '../ai-vault/session-list-results'
import { AiVaultScanCoordinator } from '../ai-vault/ai-vault-scan-coordinator'
import type { AiVaultDeleteSessionArgs } from '../../shared/ai-vault-session-deletion'
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
import { scanAiVaultSessionsByHostScope } from './ai-vault-host-scope-scan'
import { requestedAiVaultSessionDepth } from '../../shared/ai-vault-session-depth'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import {
  resolveAiVaultSessionTitlesByHost,
  type RuntimeAiVaultSessionTitleResolver,
  type RuntimeOwnedSshAiVaultSessionTitleResolver
} from './ai-vault-session-title-routing'
import type { RuntimeOwnedSshAiVaultHost } from '../ai-vault/runtime-owned-ssh-session-list'
import type { RuntimeOwnedSshAiVaultScanner } from './ai-vault-runtime-owned-ssh'

type AiVaultHandlerOptions = AiVaultSessionSources &
  AiVaultResumeHandlerOptions & {
    getActiveRuntimeAiVaultHostInfos?: () => readonly RuntimeAiVaultHostInfo[]
    scanRuntimeAiVaultSessions?: RuntimeAiVaultScanner
    resolveRuntimeAiVaultSessionTitles?: RuntimeAiVaultSessionTitleResolver
    listRuntimeOwnedSshAiVaultTargets?: (
      environmentId: string
    ) => Promise<readonly RuntimeOwnedSshAiVaultHost[]>
    findRuntimeOwningSshAiVaultHost?: (
      targetId: string
    ) => Promise<RuntimeOwnedSshAiVaultHost | null>
    scanRuntimeOwnedSshAiVaultSessions?: RuntimeOwnedSshAiVaultScanner
    resolveRuntimeOwnedSshAiVaultSessionTitles?: RuntimeOwnedSshAiVaultSessionTitleResolver
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
  resolveAiVaultSessionTitlesByHost(args, {
    resolveRuntime: handlerOptions.resolveRuntimeAiVaultSessionTitles,
    findRuntimeOwningSshAiVaultHost: handlerOptions.findRuntimeOwningSshAiVaultHost,
    resolveRuntimeOwnedSsh: handlerOptions.resolveRuntimeOwnedSshAiVaultSessionTitles
  })

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
  return scanCoordinator.run({
    key: scanKey,
    force: args?.force,
    signal: options.signal,
    start: (scanSignal) => {
      const scan = () =>
        scanAiVaultSessionsByHostScope(args, executionHostScope, scanSignal, key, {
          getActiveRuntimeAiVaultHostInfos: handlerOptions.getActiveRuntimeAiVaultHostInfos,
          scanRuntimeAiVaultSessions: handlerOptions.scanRuntimeAiVaultSessions,
          listRuntimeOwnedSshAiVaultTargets: handlerOptions.listRuntimeOwnedSshAiVaultTargets,
          findRuntimeOwningSshAiVaultHost: handlerOptions.findRuntimeOwningSshAiVaultHost,
          scanRuntimeOwnedSshAiVaultSessions: handlerOptions.scanRuntimeOwnedSshAiVaultSessions,
          scanLocal: scanLocalAiVaultSessions
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
}

async function scanLocalAiVaultSessions(
  args?: AiVaultListArgs,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  // Why: the shared cache module owns codex-home/WSL sourcing and the local
  // scan cache, so the desktop IPC path and the runtime RPC method (mobile)
  // share one cache instance and one source of managed-Codex homes.
  return listCachedLocalAiVaultSessions(
    {
      limit: args?.limit,
      unlimited: args?.unlimited,
      force: args?.force,
      scopePaths: args?.scopePaths
    },
    { signal }
  )
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
      return await listAiVaultSessions(args, { signal: controller?.signal })
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
  // DOM focus/visibility events don't fire in the renderer on macOS app
  // activation, so refresh-on-refocus needs this main-process signal.
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
