import { useCallback, useSyncExternalStore } from 'react'
import { createUuidV4 } from '../../../../../src/shared/uuid-v4'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'

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
  /** Set once it may only go on a tap: its send didn't go through. */
  readonly paused?: 'failed'
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
