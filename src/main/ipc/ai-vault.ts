import { app, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import { scanRemoteAiVaultSessions } from '../ai-vault/remote-session-scanner'
import { listClaudeSubagentSessions } from '../ai-vault/session-scanner-claude-subagents'
import { claudeProjectsRootDirs } from '../ai-vault/session-scanner-source-discovery'
import { scanAiVaultSessions } from '../ai-vault/session-scanner'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { sessionSortTime } from '../ai-vault/session-scanner-accumulator'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSubagentListArgs,
  AiVaultSubagentListResult
} from '../../shared/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostScope,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostScope
} from '../../shared/execution-host'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-filesystem-dispatch'
import { getActiveSshAiVaultHostInfo, getActiveSshAiVaultHostInfos } from './ssh'

const AI_VAULT_CACHE_TTL_MS = 15_000

type AiVaultHandlerOptions = {
  getAdditionalCodexHomePaths?: () => readonly string[]
}

type CachedAiVaultList = {
  key: string
  result: AiVaultListResult
  expiresAt: number
}

let cachedList: CachedAiVaultList | null = null
let inflightList: Promise<AiVaultListResult> | null = null
let inflightKey: string | null = null
let handlerOptions: AiVaultHandlerOptions = {}

async function listAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  const executionHostScope = normalizeExecutionHostScope(
    args?.executionHostScope ?? LOCAL_EXECUTION_HOST_ID
  )
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
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return scanLocalAiVaultSessions(args)
  }

  if (executionHostScope === 'all') {
    return mergeAiVaultListResults(
      await Promise.all([
        scanLocalAiVaultSessions(args),
        ...getActiveSshAiVaultHostInfos().map((hostInfo) =>
          scanSshAiVaultSessions(hostInfo.targetId, args)
        )
      ]),
      args?.limit
    )
  }

  const parsed = parseExecutionHostId(executionHostScope)
  if (parsed?.kind === 'ssh') {
    return scanSshAiVaultSessions(parsed.targetId, args)
  }

  return {
    sessions: [],
    issues: [
      {
        executionHostId: executionHostScope,
        agent: 'codex',
        path: executionHostScope,
        message: 'Agent Session History is not available for this execution host.'
      }
    ],
    scannedAt: new Date().toISOString()
  }
}

async function scanLocalAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  const additionalCodexSessionsDirs =
    handlerOptions.getAdditionalCodexHomePaths?.().map((homePath) => join(homePath, 'sessions')) ??
    []
  return scanAiVaultSessions({
    limit: args?.limit,
    scopePaths: args?.scopePaths,
    additionalCodexSessionsDirs,
    wslHomeDirs: await getAiVaultWslHomeDirs(),
    executionHostId: LOCAL_EXECUTION_HOST_ID
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
  return {
    sessions: [],
    issues: [
      {
        executionHostId: args.executionHostId,
        agent: 'codex',
        path: args.targetId,
        message: args.message
      }
    ],
    scannedAt: new Date().toISOString()
  }
}

function mergeAiVaultListResults(
  results: readonly AiVaultListResult[],
  rawLimit: number | undefined
): AiVaultListResult {
  const limit = rawLimit && rawLimit > 0 ? Math.floor(rawLimit) : 1000
  const byId = new Map<string, AiVaultListResult['sessions'][number]>()
  const issues: AiVaultScanIssue[] = []
  for (const result of results) {
    for (const session of result.sessions) {
      byId.set(session.id, session)
    }
    issues.push(...result.issues)
  }
  return {
    sessions: [...byId.values()]
      .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
      .slice(0, limit),
    issues,
    scannedAt: new Date().toISOString()
  }
}

export function registerAiVaultHandlers(options: AiVaultHandlerOptions = {}): void {
  handlerOptions = options
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
  // Why: subagent transcripts are read from the local filesystem. Remote
  // Claude sessions already report subagentCount 0 (finalizeSession), so the
  // UI never asks; return empty defensively rather than reading local paths.
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
}

export const _internals = {
  listAiVaultSessions,
  listAiVaultSubagentSessions,
  resetAiVaultCacheForTests
}

async function getAiVaultWslHomeDirs(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return []
  }
  const homes = await Promise.all(
    (await listWslDistrosAsync()).map((distro) => getWslHomeAsync(distro))
  )
  return homes.filter((homeDir): homeDir is string => Boolean(homeDir))
}
