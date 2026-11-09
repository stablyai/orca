import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../../src/shared/agent-session/structured-agent-session-reducer'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS,
  mergeSubmissions,
  trimRetainedItems
} from '../../../../src/shared/agent-session/view/structured-agent-session-item-retention'
import { agentSessionHasOlderTranscript } from '../../../../src/shared/agent-session/agent-session-context-clear'
import {
  DEVICE_STORE_MAX_VALUE_LENGTH,
  encodeDeviceStoreValue
} from '../../device-store/device-store-value-codec'
import { readPageDeviceStore } from '../../mobile-web-shell/bridge/page-device-store'
import {
  chatTranscriptStoreKey,
  peekStoredChatTranscript,
  rememberStoredChatTranscript,
  STORED_TRANSCRIPT_VERSION,
  type StoredChatTranscript,
  type StoredStructuredChatTranscript,
  type StoredTerminalChatTranscript
} from './mobile-native-chat-transcript-store'

// Writes and restores chat copies; kept apart from the store's reads so the boot read stays small.
const MAX_STORED_ROWS = 500

function encodeStored(stored: StoredChatTranscript): string {
  return encodeDeviceStoreValue({ v: STORED_TRANSCRIPT_VERSION, stored })
}

function terminalWindow(
  stored: StoredTerminalChatTranscript,
  rows: number
): StoredTerminalChatTranscript {
  if (rows >= stored.messages.length) {
    return stored
  }
  // Older rows past the window come back through Load earlier's tail read, so its offset no longer applies.
  return { ...stored, messages: stored.messages.slice(-rows), hasMore: true, beforeOffset: null }
}

function structuredWindow(
  stored: StoredStructuredChatTranscript,
  rows: number
): StoredStructuredChatTranscript {
  const { journal } = stored
  const items = trimRetainedItems(journal.items, rows, rows)
  if (items === journal.items) {
    return stored
  }
  return {
    ...stored,
    journal: {
      ...journal,
      items,
      submissions: mergeSubmissions(journal.submissions, [], items),
      hasOlder: agentSessionHasOlderTranscript(items, true)
    }
  }
}

/** The newest rows that fit one store value (at most 500); null when not even a few rows fit. */
export function encodeStoredChatTranscript(stored: StoredChatTranscript): string | null {
  const count = stored.kind === 'terminal' ? stored.messages.length : stored.journal.items.length
  for (let rows = Math.min(count, MAX_STORED_ROWS); rows >= 1; rows = Math.floor(rows / 2)) {
    const value = encodeStored(
      stored.kind === 'terminal' ? terminalWindow(stored, rows) : structuredWindow(stored, rows)
    )
    if (value.length <= DEVICE_STORE_MAX_VALUE_LENGTH) {
      return value
    }
  }
  return count === 0 ? encodeStored(stored) : null
}

// What a chat's copy is built from: its message list, or its session state.
type TranscriptSource = readonly NativeChatMessage[] | StructuredAgentSessionState

type NotedTranscript = {
  source: TranscriptSource
  notedAt: number
  isLive: () => boolean
  build: (savedAt: number) => StoredChatTranscript
}

// The newest copy each mounted chat holds, written at turn settle, on hidden and on unmount.
const pending = new Map<string, NotedTranscript>()
// Per chat, the latest write handed to the store: only that one may come back for a retry.
const latestWrite = new Map<string, number>()
let writes = 0
const written = new WeakSet<TranscriptSource>()

/**
 * Remembers a chat's current copy without encoding it; `source` is the array or state it came from. Its saved
 * time is the write's while the chat is live, else when the copy last changed, so "as of" never claims more.
 */
export function noteChatTranscript(
  identity: string,
  source: TranscriptSource,
  isLive: () => boolean,
  build: (savedAt: number) => StoredChatTranscript
): void {
  if (written.has(source)) {
    pending.delete(identity)
    return
  }
  pending.set(identity, { source, notedAt: Date.now(), isLive, build })
  listenForHidden()
}

// An unchanged copy is still rewritten this long after the stored one, so its saved time stays within a minute.
const SAME_COPY_REWRITE_MS = 60_000

// Whether two copies hold the same rows: an open that changed nothing then skips re-encoding the whole window.
function sameRows(a: StoredChatTranscript, b: StoredChatTranscript): boolean {
  if (a.kind === 'terminal' && b.kind === 'terminal') {
    return (
      a.messages.length === b.messages.length &&
      a.hasMore === b.hasMore &&
      a.messages[0]?.id === b.messages[0]?.id &&
      JSON.stringify(a.messages.at(-1)) === JSON.stringify(b.messages.at(-1))
    )
  }
  // A journal's cursor moves with every change to its rows.
  return (
    a.kind === 'structured' &&
    b.kind === 'structured' &&
    a.journal.epoch === b.journal.epoch &&
    a.journal.cursor?.sequence === b.journal.cursor?.sequence &&
    a.journal.items.length === b.journal.items.length &&
    a.journal.hasOlder === b.journal.hasOlder
  )
}

/** Writes a chat's noted copy now, unless the store already holds it. */
export function flushChatTranscript(identity: string): void {
  const next = pending.get(identity)
  pending.delete(identity)
  const store = readPageDeviceStore()
  if (!next || !store?.available()) {
    return
  }
  const stored = next.build(next.isLive() ? Date.now() : next.notedAt)
  const kept = peekStoredChatTranscript(identity)
  if (kept && sameRows(kept, stored) && stored.savedAt - kept.savedAt < SAME_COPY_REWRITE_MS) {
    written.add(next.source)
    return
  }
  const value = encodeStoredChatTranscript(stored)
  const write = ++writes
  latestWrite.set(identity, write)
  const superseded = (): boolean => latestWrite.get(identity) !== write
  // A refused or failed write stays noted, so the next settle, hidden or close tries again.
  const retry = (): void => {
    if (!superseded() && !pending.has(identity)) {
      pending.set(identity, next)
    }
  }
  // The shell finishes a write it was handed, so a page closing right after still keeps it.
  void store.write('cache', [{ key: chatTranscriptStoreKey(identity), value }]).then((result) => {
    if (!result.written) {
      retry()
      return
    }
    written.add(next.source)
    if (!superseded()) {
      latestWrite.delete(identity)
      rememberStoredChatTranscript(identity, value === null ? null : stored)
    }
  }, retry)
}

function flushAll(): void {
  for (const identity of pending.keys()) {
    flushChatTranscript(identity)
  }
}

let hiddenListener = false
function listenForHidden(): void {
  if (hiddenListener || typeof document === 'undefined') {
    return
  }
  hiddenListener = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAll()
    }
  })
  // A document torn down while visible fires no hidden and runs no unmount cleanups.
  window.addEventListener('pagehide', flushAll)
}

// Reducer states that still show a stored copy no live read has confirmed, with when it was saved.
const unconfirmedStates = new WeakMap<StructuredAgentSessionState, number>()
const restoredStates = new WeakMap<StoredStructuredChatTranscript, StructuredAgentSessionState>()

/** A stored structured journal as reducer state: shown, but claiming nothing about current work. One object per copy. */
export function storedStructuredAgentSessionState(
  stored: StoredStructuredChatTranscript
): StructuredAgentSessionState {
  const restored = restoredStates.get(stored)
  if (restored) {
    return restored
  }
  const state: StructuredAgentSessionState = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    ...stored.journal,
    retainedOwnItemLimit: MAX_RETAINED_OWN_ITEMS,
    retainedItemCap: MAX_RETAINED_ITEMS,
    // The live read restates these; a stored running turn or pending send must not look like work.
    working: false,
    latestTurn: null,
    actionablePromptIds: []
  }
  restoredStates.set(stored, state)
  unconfirmedStates.set(state, stored.savedAt)
  return state
}

/** The phone's copy of a structured session as reducer state; undefined while unread. */
export function storedStructuredSessionState(
  identity: string
): StructuredAgentSessionState | null | undefined {
  const stored = peekStoredChatTranscript(identity)
  if (stored === undefined) {
    return undefined
  }
  return stored?.kind === 'structured' ? storedStructuredAgentSessionState(stored) : null
}

/** When the stored copy a state still shows was saved; null once a live frame has replaced it. */
export function unconfirmedStructuredStateSavedAt(
  state: StructuredAgentSessionState
): number | null {
  return unconfirmedStates.get(state) ?? null
}

/**
 * The session reducer over a state that may be a stored copy. A live frame applies to the copy without its
 * "nothing running" placeholders, so the host's own fields decide (or an older host's row-derived fallbacks, as
 * without a copy), and confirms it. Anything else keeps the copy's mark. Returns `previous` when nothing applied.
 */
export function reduceStructuredChatState(
  previous: StructuredAgentSessionState,
  action: StructuredAgentSessionAction,
  receivedAt: number
): StructuredAgentSessionState {
  const savedAt = unconfirmedStates.get(previous)
  const live =
    action.type === 'history-page' || (action.type === 'event' && action.event.type !== 'end')
  const base =
    savedAt !== undefined && live
      ? { ...previous, working: undefined, latestTurn: undefined, actionablePromptIds: undefined }
      : previous
  const next = reduceStructuredAgentSession(base, action, receivedAt)
  if (next === base) {
    return previous
  }
  if (savedAt !== undefined && !live) {
    unconfirmedStates.set(next, savedAt)
  }
  return next
}

/** The copy a live structured state is stored as: its journal, saved now. */
export function storedStructuredCopy(
  state: StructuredAgentSessionState,
  savedAt: number
): StoredStructuredChatTranscript {
  const { epoch, cursor, fence, items, submissions, hasOlder } = state
  return {
    kind: 'structured',
    savedAt,
    journal: { epoch, cursor, fence, items, submissions, hasOlder }
  }
}
