import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { setBoundedScopeCacheEntry } from '../../../../src/shared/native-chat/native-chat-scope-cache'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { encodeNativeChatTranscriptIdentity } from '../../../../src/shared/native-chat/transcript/native-chat-transcript-retention'
import type { StructuredAgentSessionState } from '../../../../src/shared/agent-session/structured-agent-session-reducer'
import { decodeDeviceStoreValue } from '../../device-store/device-store-value-codec'
import { readPageDeviceStore } from '../../mobile-web-shell/bridge/page-device-store'
import { resolveMobileNativeChat, type MobileNativeChatTab } from './mobile-native-chat-eligibility'

// Bump when a stored shape changes: other versions read as a miss.
export const STORED_TRANSCRIPT_VERSION = 1
// Decoded copies this document keeps of what the store holds, so a remount skips the read.
const MAX_KNOWN_TRANSCRIPTS = 8

export type StoredTerminalChatTranscript = {
  kind: 'terminal'
  savedAt: number
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number | null
}

// Only the journal: what the agent is doing now (K1) comes from the live read.
export type StoredStructuredJournal = Pick<
  StructuredAgentSessionState,
  'epoch' | 'cursor' | 'fence' | 'items' | 'submissions' | 'hasOlder'
>

export type StoredStructuredChatTranscript = {
  kind: 'structured'
  savedAt: number
  journal: StoredStructuredJournal
}

export type StoredChatTranscript = StoredTerminalChatTranscript | StoredStructuredChatTranscript

export function terminalChatTranscriptIdentity(
  sourceIdentity: string,
  agent: string | null,
  sessionId: string | null,
  transcriptPath: string | null
): string {
  return encodeNativeChatTranscriptIdentity([sourceIdentity, agent, sessionId, transcriptPath])
}

export function structuredChatTranscriptIdentity(
  sourceIdentity: string,
  agent: string | null,
  sessionId: string | null
): string {
  return encodeNativeChatTranscriptIdentity([sourceIdentity, agent, sessionId])
}

/** The identity a stored tab's chat reads under, or null when the tab names no chat. */
export function storedTabChatTranscriptIdentity(
  hostId: string,
  worktreeId: string,
  tab: MobileNativeChatTab,
  // The boot read assumes readable: priming a copy for a chat that can't open yet costs one key.
  transcriptReadable = true
): string | null {
  const resolution = resolveMobileNativeChat(tab, transcriptReadable)
  if (!resolution) {
    return null
  }
  const source = encodeNativeChatTranscriptIdentity([hostId, worktreeId])
  return tab.type === 'agent-session'
    ? structuredChatTranscriptIdentity(source, resolution.agent, resolution.sessionId)
    : terminalChatTranscriptIdentity(
        source,
        resolution.agent,
        resolution.sessionId,
        resolution.transcriptPath
      )
}

// Identities carry worktree paths and transcript paths, so the key is a hash; the store already fences hosts.
export function chatTranscriptStoreKey(identity: string): string {
  return `transcript:${bytesToHex(sha256(identity))}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStoredValue(raw: string): StoredChatTranscript | null {
  const value = decodeDeviceStoreValue(raw)
  if (!isRecord(value) || value.v !== STORED_TRANSCRIPT_VERSION) {
    return null
  }
  const { stored } = value
  if (!isRecord(stored) || typeof stored.savedAt !== 'number') {
    return null
  }
  if (stored.kind === 'terminal' && Array.isArray(stored.messages)) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this page wrote the value under this version, and the store seals it.
    return stored as StoredTerminalChatTranscript
  }
  if (
    stored.kind === 'structured' &&
    isRecord(stored.journal) &&
    Array.isArray(stored.journal.items)
  ) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    return stored as StoredStructuredChatTranscript
  }
  return null
}

// What this document knows the store holds per identity: a read in flight, or its answer.
const known = new Map<string, Promise<StoredChatTranscript | null>>()
const settled = new Map<string, StoredChatTranscript | null>()

/** Records what the store now holds for a chat, as a write leaves it. */
export function rememberStoredChatTranscript(
  identity: string,
  stored: StoredChatTranscript | null
): void {
  setBoundedScopeCacheEntry(known, identity, Promise.resolve(stored), MAX_KNOWN_TRANSCRIPTS)
  setBoundedScopeCacheEntry(settled, identity, stored, MAX_KNOWN_TRANSCRIPTS)
}

function storeAvailable(): boolean {
  return readPageDeviceStore()?.available() === true
}

/** Reads several chats in one store call, as the first paint does for the active tab. */
export function primeStoredChatTranscripts(identities: readonly string[]): Promise<void> {
  const store = readPageDeviceStore()
  const unread = identities.filter((identity) => !known.has(identity))
  if (!store?.available() || unread.length === 0) {
    return Promise.resolve()
  }
  const read = store.read('cache', unread.map(chatTranscriptStoreKey)).then(
    (result) => (result.status === 'ok' ? result.values : unread.map(() => null)),
    () => unread.map(() => null)
  )
  unread.forEach((identity, at) => {
    const value = read.then((values) => {
      const raw = values[at]
      const stored = raw ? readStoredValue(raw) : null
      // A write that landed meanwhile is newer than this read.
      if (!settled.has(identity)) {
        rememberStoredChatTranscript(identity, stored)
      }
      return settled.get(identity) ?? null
    })
    setBoundedScopeCacheEntry(known, identity, value, MAX_KNOWN_TRANSCRIPTS)
  })
  return read.then(() => undefined)
}

/** The stored copy when this document already holds the answer; undefined while unread. */
export function peekStoredChatTranscript(
  identity: string
): StoredChatTranscript | null | undefined {
  if (!storeAvailable()) {
    return null
  }
  return settled.has(identity) ? (settled.get(identity) ?? null) : undefined
}

/** The stored copy, reading the store once per identity. */
export function readStoredChatTranscript(identity: string): Promise<StoredChatTranscript | null> {
  if (!storeAvailable()) {
    return Promise.resolve(null)
  }
  if (!known.has(identity)) {
    void primeStoredChatTranscripts([identity])
  }
  return known.get(identity) ?? Promise.resolve(null)
}
