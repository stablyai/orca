import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { onPageAppInactive } from '../../../../mobile-web-shell/bridge/bridge-app-inactive'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../../../../src/shared/agent-session/structured-agent-session-reducer'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-item-retention'
import { readPageDeviceStore } from '../../../../mobile-web-shell/bridge/page-device-store'
import {
  chatTranscriptStoreKey,
  peekStoredChatTranscript,
  rememberStoredChatTranscript,
  type StoredChatTranscript,
  type StoredStructuredChatTranscript
} from './mobile-native-chat-transcript-store'
import { encodeStoredChatTranscript } from './mobile-native-chat-transcript-encode'

// Writes and restores chat copies; kept apart from the store's reads so the boot read stays small.

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
  // The merger replaces a row object whenever the row changes, anywhere in the list; a copy read back from the
  // store holds other objects, so the first save after a relaunch writes once.
  if (a.kind === 'terminal' && b.kind === 'terminal') {
    return (
      a.messages.length === b.messages.length &&
      a.hasMore === b.hasMore &&
      a.messages.every((row, at) => row === b.messages[at])
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

// Chats whose copy is being encoded in slices; a hide takes the copy over and encodes it at once.
const encoding = new Map<string, NotedTranscript>()

function yieldToPage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * When a copy is written. `settle` (a turn settles, a chat closes) and `leave` (the app leaving the foreground, which
 * also fires for Notification Centre, Face ID or an Android dialog) encode in slices, so even a big chat costs no long
 * task; a swipe-kill from the app switcher comes a beat later. `leave` writes only rows the store doesn't hold yet and
 * otherwise keeps the copy noted for the next hide. `hide` encodes in one go, since the app may stop right after.
 */
type FlushWhen = 'settle' | 'hide' | 'leave'

/** Writes a chat's noted copy unless the store already holds it. */
export function flushChatTranscript(identity: string, when: FlushWhen = 'settle'): void {
  const now = when === 'hide'
  const next = pending.get(identity) ?? (now ? encoding.get(identity) : undefined)
  pending.delete(identity)
  const store = readPageDeviceStore()
  if (!next || !store?.available()) {
    return
  }
  const stored = next.build(next.isLive() ? Date.now() : next.notedAt)
  const kept = peekStoredChatTranscript(identity)
  if (kept && sameRows(kept, stored)) {
    if (when === 'leave') {
      pending.set(identity, next)
      return
    }
    if (stored.savedAt - kept.savedAt < SAME_COPY_REWRITE_MS) {
      written.add(next.source)
      return
    }
  }
  const write = ++writes
  latestWrite.set(identity, write)
  const superseded = (): boolean => latestWrite.get(identity) !== write
  if (now) {
    encoding.delete(identity)
  } else {
    encoding.set(identity, next)
  }
  // A refused or failed write stays noted, so the next settle, hidden or close tries again.
  const retry = (): void => {
    if (!superseded() && !pending.has(identity)) {
      pending.set(identity, next)
    }
  }
  void encodeStoredChatTranscript(stored, now ? null : yieldToPage)
    .then(async (value) => {
      if (encoding.get(identity) === next) {
        encoding.delete(identity)
      }
      // A newer flush of this chat started while this one encoded; it carries newer rows.
      if (superseded()) {
        return
      }
      // The shell finishes a write it was handed, so a page closing right after still keeps it.
      const result = await store.write('cache', [{ key: chatTranscriptStoreKey(identity), value }])
      if (!result.written) {
        retry()
        return
      }
      written.add(next.source)
      if (!superseded()) {
        latestWrite.delete(identity)
        rememberStoredChatTranscript(identity, value === null ? null : stored)
      }
    })
    .catch(retry)
}

function flushAll(when: Exclude<FlushWhen, 'settle'>): void {
  for (const identity of new Set([...pending.keys(), ...encoding.keys()])) {
    flushChatTranscript(identity, when)
  }
}

let listening = false
function listenForHidden(): void {
  if (listening) {
    return
  }
  listening = true
  // iOS hides the page only once the app is in the background; a swipe-kill from the app switcher comes sooner.
  onPageAppInactive(() => flushAll('leave'))
  if (typeof document === 'undefined') {
    return
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAll('hide')
    }
  })
  // A document torn down while visible fires no hidden and runs no unmount cleanups.
  window.addEventListener('pagehide', () => flushAll('hide'))
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
