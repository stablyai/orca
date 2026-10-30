import type { ChildProcessHandle, ProcessSpec } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { normalizeHookTrustKeyForLookup } from './config-toml-trust'
import { runCodexAppServerSession, type CodexAppServerInvocation } from './codex-app-server-session'

// Codex owns hook hash computation; its trust RPCs also preserve user config comments.
export {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError,
  isCodexAppServerUnsupportedError,
  type CodexAppServerInvocation
} from './codex-app-server-session'

export type CodexHookTrustGrantRequest = {
  invocation: CodexAppServerInvocation
  /** Scopes project listings; managed home hooks are user-scoped and discovered independently. */
  hooksListCwd: string
  /** Lookup-normalized keys of the managed entries; grants must never include user hooks. */
  expectedTrustKeys: string[]
  /** Exact command string written to the managed hooks.json entries. */
  managedCommand: string
}

export type CodexGrantedHookTrust = {
  /** Trust key exactly as Codex reported it. */
  key: string
  normalizedKey: string
  /** Codex-computed hash now stored as trusted_hash for this key. */
  trustedHash: string
}

/** Stable telemetry categories independent of free-form diagnostics. */
export type CodexTrustGrantSessionVerifyClass =
  | 'list-mismatch'
  | 'post-grant-untrusted'
  | 'post-grant-mismatch'

export type CodexHookTrustGrantSessionResult =
  | {
      outcome: 'granted'
      entries: CodexGrantedHookTrust[]
      /** False when every expected entry was already trusted (no write). */
      wroteTrust: boolean
    }
  | { outcome: 'verify-failed'; reason: string; reasonClass: CodexTrustGrantSessionVerifyClass }

type CodexHookListing = {
  key: string
  command: string | null
  currentHash: string
  trustStatus: string
}

/** A hooks/list entry; a Codex with no hook approvals (before 0.129) reports no hash or status. */
export type CodexListedHook = {
  key: string
  command: string | null
  currentHash: string | null
  trustStatus: string | null
  /** Whether Codex will run the hook; null when this Codex does not report it. */
  enabled: boolean | null
}

export function collectListedHooks(result: unknown): CodexListedHook[] {
  const data =
    result && typeof result === 'object' && Array.isArray((result as { data?: unknown }).data)
      ? ((result as { data: unknown[] }).data as { hooks?: unknown }[])
      : []
  const listings: CodexListedHook[] = []
  const seenKeys = new Set<string>()
  for (const entry of data) {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : []
    for (const hook of hooks as Record<string, unknown>[]) {
      if (typeof hook?.key !== 'string') {
        continue
      }
      // hooks/list repeats user-scoped hooks per cwd; grant each key only once.
      if (seenKeys.has(hook.key)) {
        continue
      }
      seenKeys.add(hook.key)
      listings.push({
        key: hook.key,
        command: typeof hook.command === 'string' ? hook.command : null,
        currentHash: typeof hook.currentHash === 'string' ? hook.currentHash : null,
        trustStatus: typeof hook.trustStatus === 'string' ? hook.trustStatus : null,
        enabled: typeof hook.enabled === 'boolean' ? hook.enabled : null
      })
    }
  }
  return listings
}

// Why only hashed listings: a grant writes Codex's hash, so a listing without one cannot be granted.
function collectHookListings(result: unknown): CodexHookListing[] {
  return collectListedHooks(result).flatMap(({ key, command, currentHash, trustStatus }) =>
    currentHash !== null && trustStatus !== null ? [{ key, command, currentHash, trustStatus }] : []
  )
}

export async function runCodexHookTrustGrantSession(
  request: CodexHookTrustGrantRequest,
  spawnImpl: (
    program: string,
    args: string[],
    options: Record<string, unknown>
  ) => ChildProcessHandle = (program, args, options) =>
    spawnProcess({ program, args, ...options } as ProcessSpec)
): Promise<CodexHookTrustGrantSessionResult> {
  return runCodexAppServerSession(
    request.invocation,
    async (rpc) => {
      const expectedKeys = new Set(request.expectedTrustKeys)
      const matchManaged = (listing: CodexHookListing): boolean =>
        listing.command === request.managedCommand &&
        expectedKeys.has(normalizeHookTrustKeyForLookup(listing.key))

      const listResult = await rpc.request('hooks/list', { cwds: [request.hooksListCwd] })
      const managedListings = collectHookListings(listResult).filter(matchManaged)
      const managedKeyCoverage = normalizedKeyCoverage(managedListings)
      if (
        managedListings.length !== expectedKeys.size ||
        !setContainsEvery(managedKeyCoverage, expectedKeys)
      ) {
        return {
          outcome: 'verify-failed',
          reason: `hooks/list reported ${managedListings.length} entries covering ${managedKeyCoverage.size} of ${expectedKeys.size} expected managed entries`,
          reasonClass: 'list-mismatch'
        }
      }

      const needingTrust = managedListings.filter((listing) => listing.trustStatus !== 'trusted')
      if (needingTrust.length > 0) {
        // Match the TUI's Trust all upsert using Codex-computed hashes.
        const value: Record<string, { trusted_hash: string }> = {}
        for (const listing of needingTrust) {
          value[listing.key] = { trusted_hash: listing.currentHash }
        }
        await rpc.request('config/batchWrite', {
          edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }],
          reloadUserConfig: true
        })
      }

      const verifyResult = await rpc.request('hooks/list', { cwds: [request.hooksListCwd] })
      const verifiedListings = collectHookListings(verifyResult).filter(matchManaged)
      const verifiedKeyCoverage = normalizedKeyCoverage(verifiedListings)
      const untrusted = verifiedListings.filter((listing) => listing.trustStatus !== 'trusted')
      if (
        verifiedListings.length !== expectedKeys.size ||
        !setContainsEvery(verifiedKeyCoverage, expectedKeys) ||
        untrusted.length > 0
      ) {
        return untrusted.length > 0
          ? {
              outcome: 'verify-failed',
              reason: `post-grant verify left ${untrusted.length} entries ${untrusted[0].trustStatus}`,
              reasonClass: 'post-grant-untrusted'
            }
          : {
              outcome: 'verify-failed',
              reason: `post-grant verify reported ${verifiedListings.length} entries covering ${verifiedKeyCoverage.size} of ${expectedKeys.size} expected entries`,
              reasonClass: 'post-grant-mismatch'
            }
      }
      return {
        outcome: 'granted',
        wroteTrust: needingTrust.length > 0,
        entries: verifiedListings.map((listing) => ({
          key: listing.key,
          normalizedKey: normalizeHookTrustKeyForLookup(listing.key),
          trustedHash: listing.currentHash
        }))
      }
    },
    spawnImpl
  )
}

function normalizedKeyCoverage(listings: readonly CodexHookListing[]): Set<string> {
  return new Set(listings.map((listing) => normalizeHookTrustKeyForLookup(listing.key)))
}

function setContainsEvery(values: ReadonlySet<string>, expected: ReadonlySet<string>): boolean {
  for (const value of expected) {
    if (!values.has(value)) {
      return false
    }
  }
  return true
}
