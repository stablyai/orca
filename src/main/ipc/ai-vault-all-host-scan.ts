import { mergeAiVaultListResults } from '../ai-vault/session-list-results'
import { scanSshAiVaultSessions } from '../ai-vault/ssh-session-list'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import type { AiVaultSessionDepth } from '../../shared/ai-vault-session-depth'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { getActiveSshAiVaultHostInfos } from './ssh'
import { discoverAiVaultHosts } from './ai-vault-host-discovery'
import {
  scanRuntimeAiVaultSessions,
  type RuntimeAiVaultHostInfo,
  type RuntimeAiVaultScanner
} from './ai-vault-runtime-scan'
import { scanHostLegWithCache } from './ai-vault-host-leg-cache'

const AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS = 3_000
// Why: a remote home with many agent roots routinely needs seconds to walk,
// stat and parse. The old shared 3s bound emptied healthy SSH hosts in the
// all-hosts view; the relay gets a real scan budget and the whole leg (relay
// attempt plus any legacy crawl) stays bounded so one host can't hold the
// merge open.
const AI_VAULT_ALL_HOST_SSH_RELAY_TIMEOUT_MS = 15_000
const AI_VAULT_ALL_HOST_SSH_TIMEOUT_MS = 20_000

export type AiVaultAllHostScanInput = {
  args: AiVaultListArgs | undefined
  signal: AbortSignal | undefined
  cacheKey: string
  depth: AiVaultSessionDepth
  scopePaths: readonly string[]
  getActiveRuntimeHostInfos: () => readonly RuntimeAiVaultHostInfo[]
  runtimeScanner: RuntimeAiVaultScanner | undefined
  /** The local leg, already degraded to an issue row so one bad host can't fail the fan-out. */
  scanLocalAsIssue: (
    args: AiVaultListArgs | undefined,
    signal: AbortSignal | undefined
  ) => Promise<AiVaultListResult>
}

/** Scans every known host (local + SSH + runtime) and merges the legs into one list. */
export async function scanAllAiVaultHostLegs(
  input: AiVaultAllHostScanInput
): Promise<AiVaultListResult> {
  const { args, signal, cacheKey, depth, scopePaths } = input
  const runtimeHosts = discoverAiVaultHosts(input.getActiveRuntimeHostInfos, {
    path: 'runtime environments',
    fallbackMessage: 'Runtime hosts are unavailable.'
  })
  const sshHosts = discoverAiVaultHosts(getActiveSshAiVaultHostInfos, {
    path: 'SSH hosts',
    fallbackMessage: 'SSH hosts are unavailable.'
  })
  const discoveryIssues = [
    ...(runtimeHosts.issue ? [runtimeHosts.issue] : []),
    ...(sshHosts.issue ? [sshHosts.issue] : [])
  ]
  const force = args?.force === true
  const scannedResults = await Promise.all([
    input.scanLocalAsIssue(args, signal),
    ...sshHosts.hostInfos.map((hostInfo) =>
      scanHostLegWithCache({
        cacheKey: `${cacheKey}|${toSshExecutionHostId(hostInfo.targetId)}`,
        depth,
        scopePaths,
        force,
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
        force,
        scan: () =>
          scanRuntimeAiVaultSessions({
            hostInfo,
            scanner: input.runtimeScanner,
            listArgs: args,
            options: { signal, timeoutMs: AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS }
          })
      })
    )
  ])
  return mergeAiVaultListResults(
    [...scannedResults, ...discoveryIssues],
    args?.limit,
    args?.unlimited
  )
}
