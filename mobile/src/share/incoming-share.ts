import { useSyncExternalStore } from 'react'

// Files are app-cache copies, so they stay readable after the sending app's URI grant ends.
export type IncomingShareFile = {
  readonly uri: string
  readonly mimeType: string
  readonly name: string
  readonly size: number | null
}

export type IncomingShare = {
  // Shared text and URLs, verbatim; several are joined one per line.
  readonly text: string
  readonly files: readonly IncomingShareFile[]
}

// Structural mirror of expo-sharing's SharePayload/ResolvedSharePayload, keeping this module free of native imports.
export type IncomingSharePayload = {
  readonly value?: string
  readonly shareType?: string
  readonly mimeType?: string
  readonly contentUri?: string | null
  readonly contentMimeType?: string | null
  readonly contentSize?: number | null
  readonly originalName?: string | null
}

const SHARE_URL = /^[a-z][a-z0-9+.-]*:\/\/expo-sharing(?:[/?#]|$)/i
// expo-sharing reports a text/* file stream as shareType 'text' whose value is its URI.
const STREAM_URI = /^(?:content:\/\/|file:\/)\S+$/i
const UNKNOWN_MIME = 'application/octet-stream'

// expo-sharing announces an Android share as <scheme>://expo-sharing.
export function isIncomingShareUrl(url: string): boolean {
  return SHARE_URL.test(url)
}

function isSharedStream(payload: IncomingSharePayload): boolean {
  const value = payload.value ?? ''
  return (
    (payload.shareType !== undefined &&
      payload.shareType !== 'text' &&
      payload.shareType !== 'url') ||
    STREAM_URI.test(value)
  )
}

// Only streams need resolving (it copies them to cache); for a shared URL it would fetch the page instead.
export function incomingShareNeedsFileCopies(payloads: readonly IncomingSharePayload[]): boolean {
  return payloads.some(isSharedStream)
}

// Java File.toURI() yields file:/data/...; file readers expect file:///data/...
function fileUri(uri: string): string {
  return uri.replace(/^file:\/(?!\/)/i, 'file:///')
}

function fileName(payload: IncomingSharePayload, uri: string): string {
  const named = payload.originalName?.trim()
  if (named) {
    return named
  }
  const tail = uri.split(/[/?#]/).findLast((part) => part.length > 0)
  return tail ?? 'attachment'
}

export function normalizeIncomingShare(
  payloads: readonly IncomingSharePayload[]
): IncomingShare | null {
  const text: string[] = []
  const files: IncomingShareFile[] = []
  for (const payload of payloads) {
    const value = payload.value ?? ''
    if (!isSharedStream(payload)) {
      if (value.trim().length > 0) {
        text.push(value)
      }
      continue
    }
    const uri = payload.contentUri || value
    if (!uri) {
      continue
    }
    files.push({
      uri: fileUri(uri),
      mimeType: payload.contentMimeType || payload.mimeType || UNKNOWN_MIME,
      name: fileName(payload, uri),
      size: typeof payload.contentSize === 'number' ? payload.contentSize : null
    })
  }
  return text.length > 0 || files.length > 0 ? { text: text.join('\n'), files } : null
}

// One pending share between the share sheet and the composer the user picks; a newer share replaces it.
let pending: IncomingShare | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function offerIncomingShare(share: IncomingShare): void {
  pending = share
  notify()
}

// Clears before returning so remounts, re-run effects and repeated bridge calls cannot apply one share twice.
export function takeIncomingShare(): IncomingShare | null {
  const share = pending
  if (share) {
    pending = null
    notify()
  }
  return share
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function read(): IncomingShare | null {
  return pending
}

export function usePendingIncomingShare(): IncomingShare | null {
  return useSyncExternalStore(subscribe, read, read)
}
