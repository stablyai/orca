import { join } from 'node:path'
import { scanAiVaultSessions } from './session-scanner'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

// Why: ONE module owns the scan cache so the desktop IPC handler AND the runtime
// RPC method share a single cache instance — opening the desktop panel and the
// mobile screen for the same scope must not double-scan hundreds of transcripts.
const AI_VAULT_CACHE_TTL_MS = 15_000

// Why: codex-home + WSL home dirs must be sourced from a serve-mode-reachable
// seam (the OrcaRuntimeService deps), NOT the window-only registerCoreHandlers
// path — `orca serve` never runs that path, so sourcing it there would silently
// drop managed-Codex sessions from remote/SSH results.
export type AiVaultSessionSources = {
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
let sources: AiVaultSessionSources = {}

export function configureAiVaultSessionSources(next: AiVaultSessionSources): void {
  sources = next
}

export async function listAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  // Scope paths change the result set, so they must be part of the cache key.
  const key = JSON.stringify({
    limit: args?.limit ?? 'default',
    scopePaths: args?.scopePaths ?? []
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
  const additionalCodexSessionsDirs =
    sources.getAdditionalCodexHomePaths?.().map((homePath) => join(homePath, 'sessions')) ?? []
  inflightList = (async () =>
    scanAiVaultSessions({
      limit: args?.limit,
      scopePaths: args?.scopePaths,
      additionalCodexSessionsDirs,
      wslHomeDirs: await getAiVaultWslHomeDirs(),
      // Why: this scan is always host-local; callers addressing this host by a
      // runtime id get the result restamped at the RPC edge, never rescanned.
      executionHostId: LOCAL_EXECUTION_HOST_ID
    }))()
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
      // different-key scan may have replaced it and must stay dedupable.
      if (inflightKey === key) {
        inflightKey = null
        inflightList = null
      }
    })
  return inflightList
}

// Exported for the subagent-transcript IPC path, which validates
// renderer-supplied paths against the same WSL-aware Claude roots the scan uses.
export async function getAiVaultWslHomeDirs(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return []
  }
  const homes = await Promise.all(
    (await listWslDistrosAsync()).map((distro) => getWslHomeAsync(distro))
  )
  return homes.filter((homeDir): homeDir is string => Boolean(homeDir))
}

// Why: tests reset module-level cache/source state between cases.
export function resetAiVaultSessionListCacheForTests(): void {
  cachedList = null
  inflightList = null
  inflightKey = null
  sources = {}
}
