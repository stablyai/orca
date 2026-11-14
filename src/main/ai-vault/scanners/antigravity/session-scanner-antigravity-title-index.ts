import { AsyncLocalStorage } from 'node:async_hooks'
import type { Stats } from 'node:fs'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  InFlightPromiseDedupe,
  stableInFlightKey
} from '../../../../shared/in-flight-promise-dedupe'
import { wslGatedStat } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import type { SessionFileCandidate } from '../../session-scanner-types'
import { readLocalAntigravityHistory } from './session-scanner-antigravity-history'
import {
  ANTIGRAVITY_INDEX_MAX_BYTES,
  antigravityMetadataTitles
} from './session-scanner-antigravity-metadata'
import { antigravityMetadataPathFromTranscriptPath } from './session-scanner-antigravity-paths'

// Antigravity writes conversation summary titles asynchronously after prompts start.
const ANTIGRAVITY_METADATA_TITLE_CACHE_MAX = 64

type AntigravityMetadataTitleCacheEntry = {
  signature: string
  titles: Map<string, string>
}

const titleLookupScope = new AsyncLocalStorage<Map<string, Promise<Map<string, string>>>>()

/** Scopes per-scan `conversation_metadata.json` reads so one scan parses each index file at most once. */
export function withAntigravityMetadataTitles<T>(read: () => Promise<T>): Promise<T> {
  return titleLookupScope.run(new Map(), read)
}

const antigravityMetadataTitleCache = new Map<string, Promise<AntigravityMetadataTitleCacheEntry>>()
const inFlightTitleReads = new InFlightPromiseDedupe<Map<string, string>>(
  0,
  ANTIGRAVITY_METADATA_TITLE_CACHE_MAX
)

/** Clears cached Antigravity metadata title entries and in-flight reads for isolated test runs. */
export function resetAntigravityMetadataTitleCacheForTests(): void {
  antigravityMetadataTitleCache.clear()
  inFlightTitleReads.clear()
}

/** Reads the summary title for a single Antigravity session ID from its sibling metadata cache. */
export async function readAntigravityMetadataTitle(
  transcriptPath: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const normalizedId = sessionId.trim()
  if (!normalizedId) {
    return null
  }
  const metadataPath = antigravityMetadataPathFromTranscriptPath(transcriptPath)
  if (!metadataPath) {
    return null
  }
  const titleBySessionId = await readAntigravityMetadataTitles(metadataPath, signal)
  return titleBySessionId.get(normalizedId) ?? null
}

/** Refresh cached titles independently: conversation_metadata.json can change after the transcript stops growing. */
export async function refreshCachedAntigravityTitle(
  candidate: SessionFileCandidate,
  session: AiVaultSession,
  signal?: AbortSignal
): Promise<AiVaultSession> {
  const title = await readAntigravityMetadataTitle(candidate.file.path, session.sessionId, signal)
  return title && (title !== session.title || session.titleKind !== 'named')
    ? { ...session, title, titleKind: 'named' }
    : session
}

/** Loads and caches session-ID summary titles for a `conversation_metadata.json` path by file stat signature. */
export function readAntigravityMetadataTitles(
  metadataPath: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const scope = titleLookupScope.getStore()
  const existing = scope?.get(metadataPath)
  if (existing) {
    return existing
  }
  const pending = readAntigravityMetadataTitlesForPath(metadataPath, signal)
  scope?.set(metadataPath, pending)
  return pending
}

async function readAntigravityMetadataTitlesForPath(
  metadataPath: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  if (signal?.aborted) {
    return new Map()
  }
  let signature: string
  let indexStat: Stats
  try {
    indexStat = await wslGatedStat(metadataPath, 'scan', signal)
    if (!indexStat.isFile() || indexStat.size > ANTIGRAVITY_INDEX_MAX_BYTES) {
      return new Map()
    }
    signature = `${indexStat.dev}:${indexStat.ino}:${indexStat.size}:${indexStat.mtimeMs}:${indexStat.ctimeMs}`
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error
    }
    return new Map()
  }

  const cachedTitles = await readCachedAntigravityMetadataTitles(metadataPath, signature)
  if (cachedTitles) {
    return cachedTitles
  }

  return inFlightTitleReads.run(stableInFlightKey([metadataPath, signature]), () =>
    loadAntigravityMetadataTitles(metadataPath, signature, signal)
  )
}

async function loadAntigravityMetadataTitles(
  metadataPath: string,
  signature: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const cachedTitles = await readCachedAntigravityMetadataTitles(metadataPath, signature)
  if (cachedTitles) {
    return cachedTitles
  }

  const pending = readLocalAntigravityHistory(metadataPath, signal).then(
    (content) => ({ signature, titles: antigravityMetadataTitles(content) }),
    (error: unknown) => {
      // Failed reads must retry even if the file signature stays unchanged.
      if (antigravityMetadataTitleCache.get(metadataPath) === pending) {
        antigravityMetadataTitleCache.delete(metadataPath)
      }
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }
      return { signature, titles: new Map<string, string>() }
    }
  )
  storeAntigravityMetadataTitleCacheEntry(metadataPath, pending)
  return (await pending).titles
}

async function readCachedAntigravityMetadataTitles(
  metadataPath: string,
  signature: string
): Promise<Map<string, string> | undefined> {
  const cached = antigravityMetadataTitleCache.get(metadataPath)
  if (!cached) {
    return undefined
  }
  const entry = await cached.catch(() => undefined)
  if (!entry || entry.signature !== signature) {
    return undefined
  }
  if (antigravityMetadataTitleCache.get(metadataPath) === cached) {
    antigravityMetadataTitleCache.delete(metadataPath)
    antigravityMetadataTitleCache.set(metadataPath, cached)
  }
  return entry.titles
}

function storeAntigravityMetadataTitleCacheEntry(
  metadataPath: string,
  pending: Promise<AntigravityMetadataTitleCacheEntry>
): void {
  antigravityMetadataTitleCache.delete(metadataPath)
  antigravityMetadataTitleCache.set(metadataPath, pending)
  if (antigravityMetadataTitleCache.size > ANTIGRAVITY_METADATA_TITLE_CACHE_MAX) {
    const oldest = antigravityMetadataTitleCache.keys().next()
    if (!oldest.done) {
      antigravityMetadataTitleCache.delete(oldest.value)
    }
  }
}
