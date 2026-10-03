import { aiVaultScanIssueResult, mergeAiVaultListResults } from '../ai-vault/session-list-results'
import { scanSshAiVaultSessions } from '../ai-vault/ssh-session-list'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostScope
} from '../../shared/execution-host'
import { getActiveSshAiVaultHostInfos } from './ssh'
import { discoverAiVaultHosts, type AiVaultHostDiscoveryResult } from './ai-vault-host-discovery'
import {
  scanRuntimeAiVaultSessions,
  type RuntimeAiVaultHostInfo,
  type RuntimeAiVaultScanner
} from './ai-vault-runtime-scan'
import { scanHostLegWithCache } from './ai-vault-host-leg-cache'
import { requestedAiVaultSessionDepth } from '../../shared/ai-vault-session-depth'
import { AI_VAULT_ALL_HOST_TIMEOUT_MS } from './ai-vault-all-host-timeouts'

export type AiVaultHostScopeScanDeps = {
  scanLocal: (
    args: AiVaultListArgs | undefined,
    signal: AbortSignal | undefined
  ) => Promise<AiVaultListResult>
  getActiveRuntimeHosts?: () => readonly RuntimeAiVaultHostInfo[]
  scanRuntime?: RuntimeAiVaultScanner
}

export function getActiveRuntimeAiVaultHostInfosResult(
  getActiveRuntimeHosts?: () => readonly RuntimeAiVaultHostInfo[]
): AiVaultHostDiscoveryResult<RuntimeAiVaultHostInfo> {
  return discoverAiVaultHosts(() => getActiveRuntimeHosts?.() ?? [], {
    path: 'runtime environments',
    fallbackMessage: 'Runtime hosts are unavailable.'
  })
}

export function getActiveSshAiVaultHostInfosResult(): AiVaultHostDiscoveryResult<{
  targetId: string
}> {
  return discoverAiVaultHosts(getActiveSshAiVaultHostInfos, {
    path: 'SSH hosts',
    fallbackMessage: 'SSH hosts are unavailable.'
  })
}

export async function scanAiVaultSessionsByHostScope(
  args: AiVaultListArgs | undefined,
  executionHostScope: ExecutionHostScope,
  signal: AbortSignal | undefined,
  cacheKey: string,
  deps: AiVaultHostScopeScanDeps
): Promise<AiVaultListResult> {
  const depth = requestedAiVaultSessionDepth(args)
  const scopePaths = args?.scopePaths ?? []
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return deps.scanLocal(args, signal)
  }
  if (executionHostScope === 'all') {
    const runtimeHosts = getActiveRuntimeAiVaultHostInfosResult(deps.getActiveRuntimeHosts)
    const sshHosts = getActiveSshAiVaultHostInfosResult()
    const runtimeResults = [
      ...(runtimeHosts.issue ? [runtimeHosts.issue] : []),
      ...(sshHosts.issue ? [sshHosts.issue] : [])
    ]
    const scannedResults = await Promise.all([
      deps.scanLocal(args, signal),
      ...sshHosts.hostInfos.map((hostInfo) =>
        scanHostLegWithCache({
          cacheKey: `${cacheKey}|${toSshExecutionHostId(hostInfo.targetId)}`,
          depth,
          scopePaths,
          force: args?.force === true,
          scan: () =>
            scanSshAiVaultSessions(hostInfo.targetId, args, {
              signal,
              timeoutMs: AI_VAULT_ALL_HOST_TIMEOUT_MS.sshScan,
              relayTimeoutMs: AI_VAULT_ALL_HOST_TIMEOUT_MS.sshScanRelay
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
              scanner: deps.scanRuntime,
              listArgs: args,
              options: { signal, timeoutMs: AI_VAULT_ALL_HOST_TIMEOUT_MS.runtimeScan }
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
      scanner: deps.scanRuntime,
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
