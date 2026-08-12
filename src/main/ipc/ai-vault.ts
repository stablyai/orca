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
  cancelledAiVaultListResult,
  mergeAiVaultListResults
} from '../ai-vault/session-list-results'
import { scanSshAiVaultSessions } from '../ai-vault/ssh-session-list'
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
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostScope,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostScope
} from '../../shared/execution-host'
import { getActiveSshAiVaultHostInfos } from './ssh'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'
import { discoverAiVaultHosts, type AiVaultHostDiscoveryResult } from './ai-vault-host-discovery'
import {
  scanRuntimeAiVaultSessions,
  type RuntimeAiVaultHostInfo,
  type RuntimeAiVaultScanner
} from './ai-vault-runtime-scan'
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

const AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS = 3_000
// Why: a remote home with many agent roots routinely needs seconds to walk,
// stat and parse. The old shared 3s bound emptied healthy SSH hosts in the
// all-hosts view; the relay gets a real scan budget and the whole leg (relay
// attempt plus any legacy crawl) stays bounded so one host can't hold the
// merge open.
const AI_VAULT_ALL_HOST_SSH_RELAY_TIMEOUT_MS = 15_000
const AI_VAULT_ALL_HOST_SSH_TIMEOUT_MS = 20_000

type AiVaultHandlerOptions = AiVaultSessionSources &
  AiVaultResumeHandlerOptions & {
    getActiveRuntimeAiVaultHostInfos?: () => readonly RuntimeAiVaultHostInfo[]
    scanRuntimeAiVaultSessions?: RuntimeAiVaultScanner
    resolveRuntimeAiVaultSessionTitles?: RuntimeAiVaultSessionTitleResolver
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
  const executionHostScope = normalizeExecutionHostScope(
    args?.executionHostScope ?? LOCAL_EXECUTION_HOST_ID
  )
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
      const scan = () => scanAiVaultSessionsByHostScope(args, executionHostScope, scanSignal, key)
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

async function scanAiVaultSessionsByHostScope(
  args: AiVaultListArgs | undefined,
  executionHostScope: ExecutionHostScope,
  signal?: AbortSignal,
  cacheKey = ''
): Promise<AiVaultListResult> {
  const depth = requestedAiVaultSessionDepth(args)
  const scopePaths = args?.scopePaths ?? []
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return scanLocalAiVaultSessionsAsIssue(args, signal)
  }
  if (executionHostScope === 'all') {
    const runtimeHosts = getActiveRuntimeAiVaultHostInfosResult()
    const sshHosts = getActiveSshAiVaultHostInfosResult()
    const runtimeResults = [
      ...(runtimeHosts.issue ? [runtimeHosts.issue] : []),
      ...(sshHosts.issue ? [sshHosts.issue] : [])
    ]
    const scannedResults = await Promise.all([
      scanLocalAiVaultSessionsAsIssue(args, signal),
      ...sshHosts.hostInfos.map((hostInfo) =>
        scanHostLegWithCache({
          cacheKey: `${cacheKey}|${toSshExecutionHostId(hostInfo.targetId)}`,
          depth,
          scopePaths,
          force: args?.force === true,
          scan: () =>
            scanSshAiVaultSessions(hostInfo.targetId, args, {
              signal,
              timeoutMs: AI_VAULT_ALL_HOST_SSH_TIMEOUT_MS,
              relayTimeoutMs: AI_VAULT_ALL_HOST_SSH_RELAY_TIMEOUT_MS
            })
        })
      ),
      ...runtimeHosts.hostInfos.map((hostInfo) =>
        scanHostLegWithCache({
          cacheKey: `${cacheKey}|${hostInfo.executionHostId}`,
          depth,
          scopePaths,
          force: args?.force === true,
          scan: () =>
            scanRuntimeAiVaultSessions({
              hostInfo,
              scanner: handlerOptions.scanRuntimeAiVaultSessions,
              listArgs: args,
              options: { signal, timeoutMs: AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS }
            })
        })
      )
    ])
    return mergeAiVaultListResults(
      [...scannedResults, ...runtimeResults],
      args?.limit,
      args?.unlimited
    )
  }

  const parsed = parseExecutionHostId(executionHostScope)
  if (parsed?.kind === 'ssh') {
    return scanSshAiVaultSessions(parsed.targetId, args, { signal })
  }
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

function getActiveRuntimeAiVaultHostInfosResult(): AiVaultHostDiscoveryResult<RuntimeAiVaultHostInfo> {
  return discoverAiVaultHosts(() => handlerOptions.getActiveRuntimeAiVaultHostInfos?.() ?? [], {
    path: 'runtime environments',
    fallbackMessage: 'Runtime hosts are unavailable.'
  })
}

function getActiveSshAiVaultHostInfosResult(): AiVaultHostDiscoveryResult<{ targetId: string }> {
  return discoverAiVaultHosts(getActiveSshAiVaultHostInfos, {
    path: 'SSH hosts',
    fallbackMessage: 'SSH hosts are unavailable.'
  })
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
    return aiVaultScanIssueResult({
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      path: 'this computer',
      message: error instanceof Error ? error.message : 'Local session scan failed.'
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
