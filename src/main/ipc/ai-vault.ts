import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { scanRemoteAiVaultSessions } from '../ai-vault/remote-session-scanner'
import { scanAiVaultSessions } from '../ai-vault/session-scanner'
import { aiVaultScanIssueResult, mergeAiVaultListResults } from '../ai-vault/session-list-results'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
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

type AiVaultHandlerOptions = {
  getAdditionalCodexHomePaths?: () => readonly string[]
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
  return aiVaultScanIssueResult({
    executionHostId: args.executionHostId,
    path: args.targetId,
    message: args.message
  })
}

export function registerAiVaultHandlers(options: AiVaultHandlerOptions = {}): void {
  handlerOptions = options
  ipcMain.handle('aiVault:listSessions', (_event, args?: AiVaultListArgs) =>
    listAiVaultSessions(args)
  )
  // DOM focus/visibility events don't fire in the renderer on macOS app
  // activation, so refresh-on-refocus needs this main-process signal.
  app.on('browser-window-focus', (_event, window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('aiVault:windowFocused')
    }
  })
}

function resetAiVaultCacheForTests(): void {
  cachedList = null
  inflightList = null
  inflightKey = null
  handlerOptions = {}
}

export const _internals = {
  listAiVaultSessions,
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
