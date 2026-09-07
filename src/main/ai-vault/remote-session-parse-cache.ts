import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { RemoteScannerContext, RemoteSessionCandidate } from './remote-session-scanner-types'

// Matches the local scanner's cap. The relay sidecar is forked with
// --max-old-space-size=384, and a retained session row is a title, a preview
// window and counters — orders of magnitude smaller than the transcript it was
// parsed from, which is what the cache stops us re-reading.
const MAX_CACHE_ENTRIES = 4096

type RemoteSessionParseCacheEntry = {
  mtimeMs: number
  sizeBytes: number | null
  hostKey: string
  session: AiVaultSession | null
}

// Module scope so it outlives one scan: the sidecar is retired only after 10
// idle minutes, so it spans many passes of a 30s cadence.
const cache = new Map<string, RemoteSessionParseCacheEntry>()

export type RemoteSessionParseStats = { reused: number; parsed: number }

export function createRemoteSessionParseStats(): RemoteSessionParseStats {
  return { reused: 0, parsed: 0 }
}

export function resetRemoteSessionParseCacheForTests(): void {
  cache.clear()
}

/** Identity of the host a parse result belongs to; a result is not portable across either field. */
export function remoteSessionParseHostKey(context: RemoteScannerContext): string {
  return `${context.executionHostId}\u0000${context.hostPlatform.relayPlatform}`
}

function storeEntry(path: string, entry: RemoteSessionParseCacheEntry): void {
  cache.delete(path)
  cache.set(path, entry)
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) {
      cache.delete(oldest.value)
    }
  }
}

/**
 * Parse a remote transcript, reusing the previous result when the file is
 * provably unchanged.
 *
 * Why this exists: the remote scanner had no cache of any kind, so every pass
 * re-read and re-parsed the whole corpus — up to 3000 whole-file reads, GBs of
 * JSONL, including July transcripts that had not changed in a month — which is
 * what pegged the relay host on the renderer's 30s forced-rescan cadence
 * (#13753). The local scanner has had `parseAgentSessionFileCached` for exactly
 * this reason; this is its remote counterpart.
 *
 * `(mtimeMs, sizeBytes)` is a sound validity key here because discovery already
 * folds a source's `contentDependencyPath` stat into both fields
 * (remote-session-scanner-discovery.ts), so a metadata-only transcript whose
 * companion file changed still looks changed. Sources whose parse reads a file
 * discovery does not stat — Codex looks its title up in `session_index.jsonl` —
 * are not covered by that key and pass `refreshReusedSession` to re-derive the
 * uncovered part without touching the transcript.
 *
 * Only a completed parse is stored. A read that threw stays uncached so a
 * transient filesystem failure cannot pin a wrong answer for the corpus's life.
 */
export async function parseRemoteSessionFileCached(args: {
  candidate: RemoteSessionCandidate
  hostKey: string
  parse: () => Promise<AiVaultSession | null>
  // Applied to a reused session only; must not re-read the transcript.
  refreshReusedSession?: (session: AiVaultSession) => Promise<AiVaultSession>
  stats?: RemoteSessionParseStats
}): Promise<AiVaultSession | null> {
  const { file } = args.candidate
  const entry = cache.get(file.path)
  const unchanged =
    entry !== undefined &&
    entry.hostKey === args.hostKey &&
    entry.mtimeMs === file.mtimeMs &&
    (entry.sizeBytes === null || file.sizeBytes === undefined || entry.sizeBytes === file.sizeBytes)
  if (unchanged) {
    if (args.stats) {
      args.stats.reused++
    }
    if (entry.session && args.refreshReusedSession) {
      entry.session = await args.refreshReusedSession(entry.session)
    }
    // Refresh recency without re-parsing so the LRU evicts cold paths first.
    storeEntry(file.path, entry)
    return entry.session
  }

  const session = await args.parse()
  if (args.stats) {
    args.stats.parsed++
  }
  storeEntry(file.path, {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    hostKey: args.hostKey,
    session
  })
  return session
}
