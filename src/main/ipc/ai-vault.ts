import { app, ipcMain } from 'electron'
import { resolve } from 'node:path'
import {
  configureAiVaultSessionSources,
  getAiVaultWslHomeDirs,
  listAiVaultSessions as listCachedLocalAiVaultSessions,
  resetAiVaultSessionListCacheForTests,
  type AiVaultSessionSources
} from '../ai-vault/cached-session-list'
import { scanRemoteAiVaultSessions } from '../ai-vault/remote-session-scanner'
import { listClaudeSubagentSessions } from '../ai-vault/session-scanner-claude-subagents'
import { claudeProjectsRootDirs } from '../ai-vault/session-scanner-source-discovery'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { aiVaultScanIssueResult, mergeAiVaultListResults } from '../ai-vault/session-list-results'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSubagentListArgs,
  AiVaultSubagentListResult
} from '../../shared/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostScope,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostScope
} from '../../shared/execution-host'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-filesystem-dispatch'
import { getActiveSshAiVaultHostInfo, getActiveSshAiVaultHostInfos } from './ssh'

const AI_VAULT_CACHE_TTL_MS = 15_000
const AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS = 3_000

type AiVaultHandlerOptions = AiVaultSessionSources & {
  getActiveRuntimeAiVaultHostInfos?: () => readonly RuntimeAiVaultHostInfo[]
  scanRuntimeAiVaultSessions?: (
    environmentId: string,
    args: AiVaultListArgs,
    options?: RuntimeAiVaultScanOptions
  ) => Promise<AiVaultListResult>
}

type RuntimeAiVaultScanOptions = {
  timeoutMs?: number
}

type CachedAiVaultList = {
  key: string
  result: AiVaultListResult
  expiresAt: number
}

type RuntimeAiVaultHostInfo = {
  environmentId: string
  executionHostId: `runtime:${string}`
}

let cachedList: CachedAiVaultList | null = null
let inflightList: Promise<AiVaultListResult> | null = null
let inflightKey: string | null = null
let handlerOptions: AiVaultHandlerOptions = {}

async function listAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  const executionHostScope = normalizeExecutionHostScope(
    args?.executionHostScope ?? LOCAL_EXECUTION_HOST_ID
  )
  // Why: local-scope scans go straight to the shared cache module (also used by
  // the runtime RPC method), so the desktop panel and a paired mobile client
  // never double-scan the same transcripts; the cache below only has to dedupe
  // the multi-host (ssh/runtime/all) merges that exist on the desktop side.
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return scanLocalAiVaultSessions(args)
  }
  // Scope paths change the result set, so they must be part of the cache key.
  const key = JSON.stringify({
    limit: args?.limit ?? 'default',
    scopePaths: args?.scopePaths ?? [],
    executionHostScope
  })
  const now = Date.now()
  // Why: opening this panel repeatedly should not re-parse hundreds of JSONL
  // transcripts; explicit refreshes bypass the cache but not an active scan.
  if (args?.force !== true && cachedList?.key === key && cachedList.expiresAt > now) {
    return cachedList.result
  }
  if (inflightList && inflightKey === key) {
    return inflightList
  }

  inflightKey = key
  inflightList = scanAiVaultSessionsByHostScope(args, executionHostScope)
    .then((result) => {
      cachedList = {
        key,
        result,
        expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
      }
      return result
    })
    .finally(() => {
      // Only clear tracking if it still refers to this request: a concurrent
      // different-scope scan may have replaced it and must stay dedupable.
      if (inflightKey === key) {
        inflightKey = null
        inflightList = null
      }
    })
  return inflightList
}

async function scanAiVaultSessionsByHostScope(
  args: AiVaultListArgs | undefined,
  executionHostScope: ExecutionHostScope
): Promise<AiVaultListResult> {
  if (executionHostScope === 'all') {
    const runtimeHosts = getActiveRuntimeAiVaultHostInfosResult()
    const runtimeResults = runtimeHosts.issue ? [runtimeHosts.issue] : []
    return mergeAiVaultListResults(
      await Promise.all([
        scanLocalAiVaultSessions(args),
        ...getActiveSshAiVaultHostInfos().map((hostInfo) =>
          scanSshAiVaultSessions(hostInfo.targetId, args)
        ),
        ...runtimeHosts.hostInfos.map((hostInfo) =>
          scanRuntimeAiVaultSessions(hostInfo, args, {
            timeoutMs: AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS
          })
        ),
        ...runtimeResults
      ]),
      args?.limit
    )
  }

  const parsed = parseExecutionHostId(executionHostScope)
  if (parsed?.kind === 'ssh') {
    return scanSshAiVaultSessions(parsed.targetId, args)
  }
  if (parsed?.kind === 'runtime') {
    return scanRuntimeAiVaultSessions(
      {
        environmentId: parsed.environmentId,
        executionHostId: toRuntimeExecutionHostId(parsed.environmentId)
      },
      args
    )
  }

  return aiVaultScanIssueResult({
    executionHostId: executionHostScope,
    path: executionHostScope,
    message: 'Agent Session History is not available for this execution host.'
  })
}

function getActiveRuntimeAiVaultHostInfos(): readonly RuntimeAiVaultHostInfo[] {
  return handlerOptions.getActiveRuntimeAiVaultHostInfos?.() ?? []
}

function getActiveRuntimeAiVaultHostInfosResult(): {
  hostInfos: readonly RuntimeAiVaultHostInfo[]
  issue?: AiVaultListResult
} {
  try {
    return { hostInfos: getActiveRuntimeAiVaultHostInfos() }
  } catch (error) {
    return {
      hostInfos: [],
      issue: runtimeHostDiscoveryIssueResult(
        error instanceof Error ? error.message : 'Runtime hosts are unavailable.'
      )
    }
  }
}

async function scanRuntimeAiVaultSessions(
  hostInfo: RuntimeAiVaultHostInfo,
  args?: AiVaultListArgs,
  options: RuntimeAiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const scanner = handlerOptions.scanRuntimeAiVaultSessions
  if (!scanner) {
    return runtimeScanIssueResult(
      hostInfo,
      'Agent Session History is not available for this execution host.'
    )
  }
  const scanArgs: AiVaultListArgs = { executionHostScope: hostInfo.executionHostId }
  if (args?.limit !== undefined) {
    scanArgs.limit = args.limit
  }
  if (args?.force !== undefined) {
    scanArgs.force = args.force
  }
  if (args?.scopePaths !== undefined) {
    scanArgs.scopePaths = args.scopePaths
  }
  try {
    return await scanner(hostInfo.environmentId, scanArgs, options)
  } catch (error) {
    return runtimeScanIssueResult(
      hostInfo,
      error instanceof Error ? error.message : 'Remote Orca server is unavailable.'
    )
  }
}

function runtimeScanIssueResult(
  hostInfo: RuntimeAiVaultHostInfo,
  message: string
): AiVaultListResult {
  return aiVaultScanIssueResult({
    executionHostId: hostInfo.executionHostId,
    path: hostInfo.environmentId,
    message
  })
}

function runtimeHostDiscoveryIssueResult(message: string): AiVaultListResult {
  return aiVaultScanIssueResult({ path: 'runtime environments', message })
}

async function scanLocalAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  // Why: the shared cache module owns codex-home/WSL sourcing and the local
  // scan cache, so the desktop IPC path and the runtime RPC method (mobile)
  // share one cache instance and one source of managed-Codex homes.
  return listCachedLocalAiVaultSessions({
    limit: args?.limit,
    force: args?.force,
    scopePaths: args?.scopePaths
  })
}

async function scanSshAiVaultSessions(
  targetId: string,
  args?: AiVaultListArgs
): Promise<AiVaultListResult> {
  const executionHostId = toSshExecutionHostId(targetId)
  const hostInfo = getActiveSshAiVaultHostInfo(targetId)
  const provider = getSshFilesystemProvider(targetId)
  if (!hostInfo || !provider) {
    return sshScanIssueResult({
      executionHostId,
      targetId,
      message: SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
    })
  }
  return scanRemoteAiVaultSessions({
    provider,
    executionHostId: hostInfo.executionHostId,
    remoteHome: hostInfo.remoteHome,
    hostPlatform: hostInfo.hostPlatform,
    limit: args?.limit,
    scopePaths: args?.scopePaths
  })
}

function sshScanIssueResult(args: {
  executionHostId: `ssh:${string}`
  targetId: string
  message: string
}): AiVaultListResult {
  return aiVaultScanIssueResult({
    executionHostId: args.executionHostId,
    path: args.targetId,
    message: args.message
  })
}

export function registerAiVaultHandlers(options: AiVaultHandlerOptions = {}): void {
  handlerOptions = options
  // Why: configure the SAME shared cache module the runtime RPC method uses so
  // there is exactly one cache instance and neither caller drops codex-home or
  // WSL injection. The runtime also configures these sources from its deps
  // (serve-mode reachable); this desktop path supplies the same source.
  configureAiVaultSessionSources(options)
  ipcMain.handle('aiVault:listSessions', (_event, args?: AiVaultListArgs) =>
    listAiVaultSessions(args)
  )
  ipcMain.handle(
    'aiVault:listSubagentSessions',
    (_event, args?: AiVaultSubagentListArgs): Promise<AiVaultSubagentListResult> =>
      listAiVaultSubagentSessions(args)
  )
  // DOM focus/visibility events don't fire in the renderer on macOS app
  // activation, so refresh-on-refocus needs this main-process signal.
  app.on('browser-window-focus', (_event, window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('aiVault:windowFocused')
    }
  })
}

// Provider-gated: only Claude materializes Task subagent transcripts as
// sibling files today; other agents resolve to an empty list.
async function listAiVaultSubagentSessions(
  args?: AiVaultSubagentListArgs
): Promise<AiVaultSubagentListResult> {
  // IPC payloads are untyped at runtime; malformed input resolves empty like
  // every other rejected input instead of throwing.
  if (
    !args ||
    args.agent !== 'claude' ||
    typeof args.parentFilePath !== 'string' ||
    !args.parentFilePath.trim()
  ) {
    return { sessions: [], issues: [] }
  }
  // Why: subagent transcripts are read from the local filesystem. The UI
  // skips remote sessions (their transcripts live on the remote host); return
  // empty defensively rather than reading local paths for a remote session.
  const executionHostId = args.executionHostId ?? LOCAL_EXECUTION_HOST_ID
  if (executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return { sessions: [], issues: [] }
  }
  // Why: the path is renderer-supplied; only list files under a known Claude
  // projects root so a crafted path can't readdir/preview arbitrary dirs.
  // resolve() collapses `..` segments first — isPathInsideOrEqual compares
  // textually and would otherwise pass `<root>/../../etc/x.jsonl`.
  const parentFilePath = resolve(args.parentFilePath)
  const roots = claudeProjectsRootDirs({ wslHomeDirs: await getAiVaultWslHomeDirs() })
  if (!roots.some((root) => isPathInsideOrEqual(resolve(root), parentFilePath))) {
    return { sessions: [], issues: [] }
  }
  return listClaudeSubagentSessions({ parentFilePath })
}

function resetAiVaultCacheForTests(): void {
  cachedList = null
  inflightList = null
  inflightKey = null
  handlerOptions = {}
  // The local leg delegates to the shared cache module; reset it too so tests
  // never see a scan cached by an earlier case.
  resetAiVaultSessionListCacheForTests()
}

export const _internals = {
  listAiVaultSessions,
  listAiVaultSubagentSessions,
  resetAiVaultCacheForTests
}
