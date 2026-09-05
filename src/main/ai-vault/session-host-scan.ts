import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostScope
} from '../../shared/execution-host'
import {
  requestedAiVaultSessionDepth,
  type AiVaultSessionDepth
} from '../../shared/ai-vault-session-depth'
import {
  discoverAiVaultHosts,
  type AiVaultHostDiscoveryResult
} from '../ipc/ai-vault-host-discovery'
import {
  scanRuntimeAiVaultSessions,
  type RuntimeAiVaultHostInfo,
  type RuntimeAiVaultScanner
} from '../ipc/ai-vault-runtime-scan'
import { scanHostLegWithCache } from '../ipc/ai-vault-host-leg-cache'
import { getActiveSshAiVaultHostInfos } from '../ipc/ssh'
import { aiVaultScanIssueResult, mergeAiVaultListResults } from './session-list-results'
import { scanSshAiVaultSessions } from './ssh-session-list'

const AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS = 3_000
// Why: a remote home with many agent roots routinely needs seconds to walk,
// stat and parse. The old shared 3s bound emptied healthy SSH hosts in the
// all-hosts view; the relay gets a real scan budget and the whole leg (relay
// attempt plus any legacy crawl) stays bounded so one host can't hold the
// merge open.
const AI_VAULT_ALL_HOST_SSH_RELAY_TIMEOUT_MS = 15_000
const AI_VAULT_ALL_HOST_SSH_TIMEOUT_MS = 20_000

export type AiVaultHostScanDeps = {
  getActiveRuntimeAiVaultHostInfos?: () => readonly RuntimeAiVaultHostInfo[]
  scanRuntimeAiVaultSessions?: RuntimeAiVaultScanner
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
  deps: AiVaultHostScanDeps
): Promise<AiVaultListResult> {
  const depth = requestedAiVaultSessionDepth(args)
  const scopePaths = args?.scopePaths ?? []
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return deps.scanLocal(args, signal)
  }
  if (executionHostScope === 'all') {
    return scanAllHostAiVaultSessions(args, signal, cacheKey, depth, scopePaths, deps)
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
      scanner: deps.scanRuntimeAiVaultSessions,
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

async function scanAllHostAiVaultSessions(
  args: AiVaultListArgs | undefined,
  signal: AbortSignal | undefined,
  cacheKey: string,
  depth: AiVaultSessionDepth,
  scopePaths: readonly string[],
  deps: AiVaultHostScanDeps
): Promise<AiVaultListResult> {
  const runtimeHosts = getActiveRuntimeAiVaultHostInfosResult(deps)
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
            scanner: deps.scanRuntimeAiVaultSessions,
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

function getActiveRuntimeAiVaultHostInfosResult(
  deps: AiVaultHostScanDeps
): AiVaultHostDiscoveryResult<RuntimeAiVaultHostInfo> {
  return discoverAiVaultHosts(() => deps.getActiveRuntimeAiVaultHostInfos?.() ?? [], {
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
