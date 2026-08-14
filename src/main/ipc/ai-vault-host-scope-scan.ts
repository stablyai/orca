import { scanSshAiVaultSessions } from '../ai-vault/ssh-session-list'
import {
  abandonRemoteSessionScanOnCancel,
  throwIfAiVaultScanCancelled
} from '../ai-vault/ai-vault-scan-cancellation'
import { aiVaultScanIssueResult, mergeAiVaultListResults } from '../ai-vault/session-list-results'
import { requestedAiVaultSessionDepth } from '../../shared/ai-vault-session-depth'
import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostScope
} from '../../shared/execution-host'
import { getActiveSshAiVaultHostInfos } from './ssh'
import { discoverAiVaultHosts } from './ai-vault-host-discovery'
import {
  scanRuntimeAiVaultSessions,
  type RuntimeAiVaultHostInfo,
  type RuntimeAiVaultScanner
} from './ai-vault-runtime-scan'
import { scanHostLegWithCache } from './ai-vault-host-leg-cache'
import {
  scanSshAiVaultSessionsByOwner,
  type RuntimeOwnedSshAiVaultScanner
} from './ai-vault-runtime-owned-ssh'
import type { RuntimeOwnedSshAiVaultHost } from '../ai-vault/runtime-owned-ssh-session-list'

export const AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS = 3_000
export const AI_VAULT_ALL_HOST_SSH_RELAY_TIMEOUT_MS = 15_000
export const AI_VAULT_ALL_HOST_SSH_TIMEOUT_MS = 20_000

export type AiVaultHostScopeScanOptions = {
  getActiveRuntimeAiVaultHostInfos?: () => readonly RuntimeAiVaultHostInfo[]
  scanRuntimeAiVaultSessions?: RuntimeAiVaultScanner
  listRuntimeOwnedSshAiVaultTargets?: (
    environmentId: string
  ) => Promise<readonly RuntimeOwnedSshAiVaultHost[]>
  findRuntimeOwningSshAiVaultHost?: (targetId: string) => Promise<RuntimeOwnedSshAiVaultHost | null>
  scanRuntimeOwnedSshAiVaultSessions?: RuntimeOwnedSshAiVaultScanner
  scanLocal: (
    args: AiVaultListArgs | undefined,
    signal: AbortSignal | undefined
  ) => Promise<AiVaultListResult>
}

export async function scanAiVaultSessionsByHostScope(
  args: AiVaultListArgs | undefined,
  executionHostScope: ExecutionHostScope,
  signal: AbortSignal | undefined,
  cacheKey: string,
  options: AiVaultHostScopeScanOptions
): Promise<AiVaultListResult> {
  const depth = requestedAiVaultSessionDepth(args)
  const scopePaths = args?.scopePaths ?? []
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return scanLocalAiVaultSessionsAsIssue(options.scanLocal, args, signal)
  }
  if (executionHostScope === 'all') {
    return scanAllAiVaultHosts(args, signal, cacheKey, depth, scopePaths, options)
  }

  const parsed = parseExecutionHostId(executionHostScope)
  if (parsed?.kind === 'ssh') {
    return scanSshAiVaultSessionsByOwner({
      targetId: parsed.targetId,
      listArgs: args,
      signal,
      ownedTimeoutMs: AI_VAULT_ALL_HOST_SSH_TIMEOUT_MS,
      findOwner: options.findRuntimeOwningSshAiVaultHost,
      scanOwned: options.scanRuntimeOwnedSshAiVaultSessions
    })
  }
  if (parsed?.kind === 'runtime') {
    return scanRuntimeAiVaultSessions({
      hostInfo: {
        environmentId: parsed.environmentId,
        executionHostId: toRuntimeExecutionHostId(parsed.environmentId)
      },
      scanner: options.scanRuntimeAiVaultSessions,
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

async function scanAllAiVaultHosts(
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined,
  cacheKey: string,
  depth: ReturnType<typeof requestedAiVaultSessionDepth>,
  scopePaths: readonly string[],
  options: AiVaultHostScopeScanOptions
): Promise<AiVaultListResult> {
  const runtimeHosts = discoverAiVaultHosts(
    () => options.getActiveRuntimeAiVaultHostInfos?.() ?? [],
    { path: 'runtime environments', fallbackMessage: 'Runtime hosts are unavailable.' }
  )
  const sshHosts = discoverAiVaultHosts(getActiveSshAiVaultHostInfos, {
    path: 'SSH hosts',
    fallbackMessage: 'SSH hosts are unavailable.'
  })
  // Why: keep runtime host-local legs on the 3s budget. Folding that runtime's
  // SSH inventory into the same RPC made one slow SSH host fail the runtime row.
  const localSshTargetIds = new Set(sshHosts.hostInfos.map((hostInfo) => hostInfo.targetId))
  const [scannedResults, runtimeOwnedSshResults] = await Promise.all([
    Promise.all([
      scanLocalAiVaultSessionsAsIssue(options.scanLocal, args, signal),
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
              scanner: options.scanRuntimeAiVaultSessions,
              listArgs: args,
              options: {
                signal,
                timeoutMs: AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS
              }
            })
        })
      )
    ]),
    scanRuntimeOwnedSshHosts(
      args,
      signal,
      cacheKey,
      depth,
      scopePaths,
      localSshTargetIds,
      runtimeHosts.hostInfos,
      options
    )
  ])
  return mergeAiVaultListResults(
    [
      ...scannedResults,
      ...runtimeOwnedSshResults,
      ...(runtimeHosts.issue ? [runtimeHosts.issue] : []),
      ...(sshHosts.issue ? [sshHosts.issue] : [])
    ],
    args?.limit,
    args?.unlimited
  )
}

async function scanRuntimeOwnedSshHosts(
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined,
  cacheKey: string,
  depth: ReturnType<typeof requestedAiVaultSessionDepth>,
  scopePaths: readonly string[],
  localSshTargetIds: ReadonlySet<string>,
  runtimeHosts: readonly RuntimeAiVaultHostInfo[],
  options: AiVaultHostScopeScanOptions
): Promise<AiVaultListResult[]> {
  const listTargets = options.listRuntimeOwnedSshAiVaultTargets
  const scanOwned = options.scanRuntimeOwnedSshAiVaultSessions
  if (!listTargets || !scanOwned || runtimeHosts.length === 0) {
    return []
  }
  const inventories = await Promise.all(
    runtimeHosts.map(async (hostInfo) => {
      try {
        return await listTargets(hostInfo.environmentId)
      } catch {
        return []
      }
    })
  )
  const seen = new Set(localSshTargetIds)
  const ownedHosts = inventories.flat().filter((host) => {
    // Old hosts omit `connected`; those cannot scan ssh: ids anyway.
    if (host.connected !== true) {
      return false
    }
    if (seen.has(host.targetId)) {
      return false
    }
    seen.add(host.targetId)
    return true
  })
  return Promise.all(
    ownedHosts.map((host) =>
      scanHostLegWithCache({
        cacheKey: `${cacheKey}|${host.executionHostId}`,
        depth,
        scopePaths,
        force: args?.force === true,
        scan: () => {
          throwIfAiVaultScanCancelled(signal)
          return abandonRemoteSessionScanOnCancel(
            scanOwned(host.environmentId, host.targetId, args ?? {}, {
              timeoutMs: AI_VAULT_ALL_HOST_SSH_TIMEOUT_MS
            }),
            signal
          )
        }
      })
    )
  )
}

async function scanLocalAiVaultSessionsAsIssue(
  scanLocal: AiVaultHostScopeScanOptions['scanLocal'],
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined
): Promise<AiVaultListResult> {
  try {
    return await scanLocal(args, signal)
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
