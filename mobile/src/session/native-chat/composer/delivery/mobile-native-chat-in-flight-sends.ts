import { useSyncExternalStore } from 'react'
import { createNonSecureContextUuid as createUuidV4 } from '../../../../../../src/shared/non-secure-context-uuid'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from '../drafts/mobile-native-chat-draft-inputs'
import type { PendingNativeChatFile } from '../attachments/mobile-native-chat-file-attachment'
import type { MobileNativeChatSendOrigin } from '../../transcript/sending/mobile-native-chat-pending-echo'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'
import { saveMobileNativeChatDraft } from '../drafts/mobile-native-chat-draft-persistence'
import type {
  MobileNativeChatInFlightSend,
  MobileNativeChatSavedFile,
  MobileNativeChatSavedImage
} from '../drafts/mobile-native-chat-saved-drafts'
import type { PendingNativeChatImage } from '../attachments/mobile-native-chat-image-attachment'

// Sends cleared from the box before their outcome was known. `held` marks one a live hold is waiting on;
// the rest came back with the page and wait for their chat to open.
type InFlightEntry = {
  scope: string
  send: MobileNativeChatInFlightSend
  held: boolean
  // Chip ids this send took; a sent send drops them in the same write that forgets it.
  carriedIds?: ReadonlySet<string>
}
const inFlightSends = new Map<string, InFlightEntry>()
// Bumped when saved sends become claimable (a load brought them back or a hold let go).
let savedInFlightVersion = 0
const savedInFlightListeners = new Set<() => void>()

function subscribeSavedInFlight(listener: () => void): () => void {
  savedInFlightListeners.add(listener)
  return () => {
    savedInFlightListeners.delete(listener)
  }
}

function notifyClaimable(): void {
  savedInFlightVersion += 1
  savedInFlightListeners.forEach((listener) => listener())
}

export function useMobileNativeChatSavedInFlightVersion(): number {
  const read = (): number => savedInFlightVersion
  return useSyncExternalStore(subscribeSavedInFlight, read, read)
}

/** Saves the send with the clear that emptied the box, so a kill mid-send cannot lose it. */
export function beginMobileNativeChatInFlightSend(
  origin: MobileNativeChatSendOrigin,
  kind: MobileNativeChatInFlightSend['kind'],
  text: string,
  // A command's restore keeps a lone /clear or /compact and warns instead of saying it is back.
  extra: {
    clientMessageId?: string
    command?: boolean
    // Its chips (only those this send took); a queued message also brings its own skills and id, so it is saved once.
    intent?: MobileNativeChatSendIntent
  } = {}
): string | null {
  const destination = origin.draftDestination
  if (!destination.active) {
    return null
  }
  const scope = destination.scope
  const inputs = readMobileNativeChatDraftInputs(scope)
  const queued = extra.intent?.queued
  const carried = queued ?? extra.intent?.carried
  const id = queued?.id ?? createUuidV4()
  inFlightSends.set(id, {
    scope,
    held: true,
    // Only the composer's chips: a queued message's own chips were never in the box.
    carriedIds: new Set(
      [...(extra.intent?.carried?.images ?? []), ...(extra.intent?.carried?.files ?? [])].map(
        (chip) => chip.id
      )
    ),
    send: {
      id,
      kind,
      text,
      skills: queued?.skills ?? inputs.skills,
      images: (carried?.images ?? []).map(({ path }) => ({ path })),
      files: savedMobileNativeChatFiles(carried?.files ?? []),
      sessionId: origin.pendingKey?.slice(origin.draftKey.length + 1) ?? null,
      ...(extra.clientMessageId === undefined ? {} : { clientMessageId: extra.clientMessageId }),
      ...(extra.command ? { command: true } : {}),
      normalizedText: origin.normalizedText,
      baselineTailMessageId: origin.boundary.afterMessageId ?? null,
      ...(origin.queuedDuringWorkingEpoch !== undefined ? { queuedDuringWork: true } : {})
    }
  })
  saveMobileNativeChatDraft(scope, 'immediate')
  return id
}

/** The outcome is known (sent, refused, or handed back): the saved copy goes. */
export function settleMobileNativeChatInFlightSend(
  id: string | null,
  outcome: 'sent' | 'kept' = 'kept'
): void {
  const entry = id ? inFlightSends.get(id) : undefined
  if (!entry || !id) {
    return
  }
  inFlightSends.delete(id)
  const carried = entry.carriedIds
  // A sent send's chips leave the box in the same write, so a kill can't bring them back as a draft.
  if (outcome === 'sent' && carried && carried.size > 0) {
    updateMobileNativeChatDraftInputs(entry.scope, (inputs) => ({
      ...inputs,
      images: inputs.images.filter((image) => !carried.has(image.id)),
      files: inputs.files.filter((file) => !carried.has(file.id))
    }))
  }
  saveMobileNativeChatDraft(entry.scope, 'immediate')
}

/** Saved sends nobody is waiting on yet; the caller now holds them until it settles or releases them. */
export function claimMobileNativeChatInFlightSends(
  matches: (scope: string, send: MobileNativeChatInFlightSend) => boolean
): MobileNativeChatInFlightSend[] {
  const claimed: MobileNativeChatInFlightSend[] = []
  for (const entry of inFlightSends.values()) {
    if (!entry.held && matches(entry.scope, entry.send)) {
      entry.held = true
      claimed.push(entry.send)
    }
  }
  return claimed
}

export function releaseMobileNativeChatInFlightSends(ids: Iterable<string>): void {
  let released = false
  for (const id of ids) {
    const entry = inFlightSends.get(id)
    if (entry?.held) {
      entry.held = false
      released = true
    }
  }
  // An open chat claims it now rather than at its next mount.
  if (released) {
    notifyClaimable()
  }
}

/** A structured send is known by the id the desktop records it under. */
export function mobileNativeChatInFlightSendIds(clientMessageIds: ReadonlySet<string>): string[] {
  return [...inFlightSends.values()].flatMap(({ send }) =>
    send.clientMessageId !== undefined && clientMessageIds.has(send.clientMessageId)
      ? [send.id]
      : []
  )
}

export function savedMobileNativeChatFiles(
  files: readonly PendingNativeChatFile[]
): MobileNativeChatSavedFile[] {
  return files.flatMap(({ name, mime, byteLength, path }) =>
    path === null ? [] : [{ name, mime, byteLength, path }]
  )
}

// Phone previews die with the page; a restored image chip shows its file name instead.
export function restoredImages(
  images: readonly MobileNativeChatSavedImage[]
): PendingNativeChatImage[] {
  return images.map(({ path }) => ({ id: createUuidV4(), path, previewUri: '' }))
}

export function restoredFiles(
  files: readonly MobileNativeChatSavedFile[]
): PendingNativeChatFile[] {
  return files.map((file) => ({ ...file, id: createUuidV4() }))
}

export function readMobileNativeChatInFlightSend(
  id: string
): { scope: string; send: MobileNativeChatInFlightSend } | null {
  return inFlightSends.get(id) ?? null
}

export function readMobileNativeChatInFlightSendsByScope(): Map<
  string,
  MobileNativeChatInFlightSend[]
> {
  const byScope = new Map<string, MobileNativeChatInFlightSend[]>()
  for (const { scope, send } of inFlightSends.values()) {
    byScope.set(scope, [...(byScope.get(scope) ?? []), send])
  }
  return byScope
}

/** Sends a load brought back; they wait for their chat to open. */
export function registerSavedMobileNativeChatInFlightSends(
  scope: string,
  sends: readonly MobileNativeChatInFlightSend[]
): void {
  const returned = sends.filter((send) => !inFlightSends.has(send.id))
  for (const send of returned) {
    inFlightSends.set(send.id, { scope, send, held: false })
  }
  if (returned.length > 0) {
    notifyClaimable()
  }
}

export function retireMobileNativeChatInFlightSends(scope: string): void {
  for (const [id, entry] of inFlightSends) {
    if (entry.scope === scope) {
      inFlightSends.delete(id)
    }
  }
}
