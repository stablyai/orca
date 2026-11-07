import { useCallback, useSyncExternalStore } from 'react'
import { createUuidV4 } from '../../../../../src/shared/uuid-v4'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import { saveMobileNativeChatDraft } from './mobile-native-chat-draft-persistence'
import {
  restoredFiles,
  restoredImages,
  savedMobileNativeChatFiles
} from './mobile-native-chat-in-flight-sends'
import type {
  MobileNativeChatInFlightSend,
  MobileNativeChatSavedQueuedSend
} from './mobile-native-chat-saved-drafts'

/** A message sent while the desktop was out: it waits on the phone and never sat in the composer. */
export type MobileNativeChatOfflineSend = {
  readonly id: string
  /** Send order, kept so messages that come back late line up as they were sent. */
  readonly seq: number
  readonly text: string
  readonly alternate?: true
  readonly goal?: true
  readonly images: readonly PendingNativeChatImage[]
  readonly files: readonly PendingNativeChatFile[]
  readonly skills: readonly AgentJournalSkillRef[]
  readonly skillOrigin: string | null
  /** Set once it may only go on a tap: its send didn't go through, or Orca closed before it went. */
  readonly paused?: 'failed' | 'closed'
  /** On its way: it keeps its place until the send settles, but takes no new action. */
  readonly sending?: true
}

const NO_SENDS: readonly MobileNativeChatOfflineSend[] = []
const queues = new Map<string, readonly MobileNativeChatOfflineSend[]>()
const listeners = new Set<() => void>()
let nextSeq = 0

function write(
  scope: string,
  update: (
    current: readonly MobileNativeChatOfflineSend[]
  ) => readonly MobileNativeChatOfflineSend[]
): void {
  const current = queues.get(scope) ?? NO_SENDS
  const next = update(current)
  if (next === current) {
    return
  }
  if (next.length === 0) {
    queues.delete(scope)
  } else {
    queues.set(scope, next)
  }
  listeners.forEach((listener) => listener())
  // Saved with the tab's chat draft, so a message queued before a kill comes back.
  saveMobileNativeChatDraft(scope, 'immediate')
}

export function mobileNativeChatOfflineSendScopes(): string[] {
  return [...queues.keys()]
}

export function readMobileNativeChatOfflineSends(
  scope: string | null
): readonly MobileNativeChatOfflineSend[] {
  return scope ? (queues.get(scope) ?? NO_SENDS) : NO_SENDS
}

export function queueMobileNativeChatOfflineSend(
  scope: string,
  send: Omit<MobileNativeChatOfflineSend, 'id' | 'seq'>
): void {
  write(scope, (current) => [...current, { ...send, id: createUuidV4(), seq: nextSeq++ }])
}

export function removeMobileNativeChatOfflineSends(scope: string, ids: readonly string[]): void {
  const removed = new Set(ids)
  write(scope, (current) =>
    current.some((send) => removed.has(send.id))
      ? current.filter((send) => !removed.has(send.id))
      : current
  )
}

/** Puts a send that didn't go back, paused, in its original place: the ones after it wait behind it. */
export function returnMobileNativeChatOfflineSend(
  scope: string,
  send: MobileNativeChatOfflineSend
): void {
  write(scope, (current) => {
    const rest = current.filter((queued) => queued.id !== send.id)
    const at = rest.findIndex((queued) => queued.seq > send.seq)
    const returned = { ...send, paused: 'failed' as const }
    return at === -1 ? [...rest, returned] : [...rest.slice(0, at), returned, ...rest.slice(at)]
  })
}

/** What the chat draft row keeps; a message on its way is saved once, as in flight. */
export function savedMobileNativeChatOfflineSends(
  scope: string,
  inFlight: readonly MobileNativeChatInFlightSend[]
): MobileNativeChatSavedQueuedSend[] {
  return readMobileNativeChatOfflineSends(scope).flatMap((send) =>
    inFlight.some((sent) => sent.id === send.id)
      ? []
      : [
          {
            text: send.text,
            ...(send.alternate ? { alternate: true as const } : {}),
            ...(send.goal ? { goal: true as const } : {}),
            skills: send.skills,
            skillOrigin: send.skillOrigin,
            images: send.images.map(({ path }) => ({ path })),
            files: savedMobileNativeChatFiles(send.files)
          }
        ]
  )
}

export function beginMobileNativeChatOfflineSend(scope: string, id: string): void {
  write(scope, (current) =>
    current.map((send) => (send.id === id ? { ...send, sending: true as const } : send))
  )
}

/** A sent message leaves; one that didn't go stays in its place, paused. */
export function settleMobileNativeChatOfflineSend(scope: string, id: string, sent: boolean): void {
  write(scope, (current) =>
    sent
      ? current.filter((send) => send.id !== id)
      : current.map(({ sending: _sending, ...send }) =>
          send.id === id ? { ...send, paused: 'failed' as const } : send
        )
  )
}

/** Messages saved before Orca closed come back paused: nothing goes out later without a tap. */
export function restoreMobileNativeChatOfflineSends(
  scope: string,
  saved: readonly MobileNativeChatSavedQueuedSend[]
): void {
  write(scope, (current) =>
    current.length > 0 || saved.length === 0
      ? current
      : saved.map((send) => ({
          ...send,
          images: restoredImages(send.images),
          files: restoredFiles(send.files),
          id: createUuidV4(),
          seq: nextSeq++,
          paused: 'closed'
        }))
  )
}

/** A closed tab's queue goes with it, as its draft does. */
export function dropMobileNativeChatOfflineSends(scope: string): void {
  write(scope, () => NO_SENDS)
}

export function resumeMobileNativeChatOfflineSends(scope: string): void {
  write(scope, (current) =>
    current.some((send) => send.paused)
      ? current.map(({ paused: _paused, ...send }) => send)
      : current
  )
}

export function useMobileNativeChatOfflineSends(
  scope: string | null
): readonly MobileNativeChatOfflineSend[] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return useSyncExternalStore(subscribe, () => readMobileNativeChatOfflineSends(scope))
}

export function resetMobileNativeChatOfflineSendsForTests(): void {
  queues.clear()
}
