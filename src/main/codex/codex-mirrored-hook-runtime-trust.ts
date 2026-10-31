import { resolveCodexCommand } from '../codex-cli/command'
import { CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS } from './app-server/codex-app-server-capability-cache'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { listCodexHooks } from './codex-hook-trust-derivation'
import { CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS } from './codex-trust-grant-cooldown'
import {
  computeTrustKey,
  getHookTrustKeyWriteVariants,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

export type CodexHookCurrentHashListing = {
  key: string
  command: string | null
  currentHash: string
}

type MirroredHookCurrentHashListRunner = (
  runtimeHomePath: string
) => readonly CodexHookCurrentHashListing[]

let listRunner: MirroredHookCurrentHashListRunner | null = null
const unsupportedUntilByHome = new Map<string, number>()
const retryAfterByHome = new Map<string, number>()

export function stampMirroredRuntimeTrustWithCurrentHashes(
  entries: readonly CodexTrustEntry[],
  listings: readonly CodexHookCurrentHashListing[]
): CodexTrustEntry[] {
  const listingByKey = new Map<string, CodexHookCurrentHashListing>()
  for (const listing of listings) {
    const normalizedKey = normalizeHookTrustKeyForLookup(listing.key)
    if (!listingByKey.has(normalizedKey)) {
      listingByKey.set(normalizedKey, listing)
    }
  }
  return entries.map((entry) => {
    const listing = listingByKey.get(normalizeHookTrustKeyForLookup(computeTrustKey(entry)))
    if (!listing) {
      return entry
    }
    // Why: command:null is an incomplete hooks/list record, not a match.
    if (listing.command !== entry.command) {
      return entry
    }
    return { ...entry, trustedHash: listing.currentHash }
  })
}

export function clearHookTrustKeySeparatorVariants(
  tomlPath: string,
  keys: readonly string[]
): void {
  if (keys.length === 0) {
    return
  }
  removeHookTrustEntries(
    tomlPath,
    keys.flatMap((key) => getHookTrustKeyWriteVariants(key))
  )
}

export async function resolveMirroredRuntimeUserHookTrustEntries(args: {
  entries: readonly CodexTrustEntry[]
  runtimeHomePath: string
  tomlPath: string
}): Promise<CodexTrustEntry[]> {
  if (args.entries.length === 0) {
    return []
  }
  const listings = await tryListMirroredHookCurrentHashes(args.runtimeHomePath)
  if (listings) {
    return stampMirroredRuntimeTrustWithCurrentHashes(args.entries, listings)
  }
  return preserveExistingRuntimeHashes(args.entries, args.tomlPath)
}

function preserveExistingRuntimeHashes(
  entries: readonly CodexTrustEntry[],
  tomlPath: string
): CodexTrustEntry[] {
  const existing = readHookTrustEntries(tomlPath)
  return entries.map((entry) => {
    const trustedHash = existing.get(computeTrustKey(entry))?.trustedHash
    return trustedHash ? { ...entry, trustedHash } : entry
  })
}

// Why: the capability cache only keys WSL distros. Native homes already learn
// Codex hashes through listCodexHooks, so this path does not invent a native host key.
async function tryListMirroredHookCurrentHashes(
  runtimeHomePath: string
): Promise<readonly CodexHookCurrentHashListing[] | null> {
  if (listRunner) {
    return listRunner(runtimeHomePath)
  }
  const now = Date.now()
  const unsupportedUntil = unsupportedUntilByHome.get(runtimeHomePath)
  if (unsupportedUntil !== undefined && now < unsupportedUntil) {
    return null
  }
  const retryAfter = retryAfterByHome.get(runtimeHomePath)
  if (retryAfter !== undefined && now < retryAfter) {
    return null
  }
  try {
    const listings = await listCodexHooks(resolveCodexCommand(), runtimeHomePath, runtimeHomePath)
    unsupportedUntilByHome.delete(runtimeHomePath)
    retryAfterByHome.delete(runtimeHomePath)
    return listings.flatMap((listing) =>
      listing.currentHash === null
        ? []
        : [{ key: listing.key, command: listing.command, currentHash: listing.currentHash }]
    )
  } catch (error) {
    if (isCodexAppServerUnsupportedError(error)) {
      retryAfterByHome.delete(runtimeHomePath)
      unsupportedUntilByHome.set(
        runtimeHomePath,
        Date.now() + CODEX_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS
      )
      return null
    }
    unsupportedUntilByHome.delete(runtimeHomePath)
    retryAfterByHome.set(runtimeHomePath, Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS)
    return null
  }
}

export const _internals = {
  setListRunner(runner: MirroredHookCurrentHashListRunner | null): void {
    listRunner = runner
  },
  resetRetryState(): void {
    unsupportedUntilByHome.clear()
    retryAfterByHome.clear()
  }
}
