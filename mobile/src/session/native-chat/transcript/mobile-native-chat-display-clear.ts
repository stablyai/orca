import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import * as z from 'zod'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import {
  NATIVE_CHAT_ROLES,
  NATIVE_CHAT_SOURCES,
  nativeChatSemanticRowId,
  type NativeChatMessage
} from '../../../../../src/shared/native-chat/native-chat-types'
import { compareNativeChatTranscriptMessages } from '../../../../../src/shared/native-chat/transcript/native-chat-transcript-projection'
import { setBoundedScopeCacheEntry } from '../../../../../src/shared/native-chat/native-chat-scope-cache'
import {
  decodeDeviceStoreValue,
  encodeDeviceStoreValue
} from '../../../device-store/device-store-value-codec'
import { readPageDeviceStore } from '../../../mobile-web-shell/bridge/page-device-store'
import { chatTranscriptStoreKey } from './mobile-native-chat-transcript-store'

// Store only placement, never a second copy of the message's content.
const boundarySchema = z
  .object({
    id: z.string(),
    role: z.enum(NATIVE_CHAT_ROLES),
    timestamp: z.number().nullable(),
    source: z.enum(NATIVE_CHAT_SOURCES),
    transcriptOrder: z.number().optional()
  })
  .transform((row): NativeChatMessage => ({ ...row, blocks: [] }))
const pageSchema = z.looseObject({ messages: z.array(boundarySchema) })
const clearSchema = z.object({
  row: boundarySchema.nullable(),
  preview: z
    .object({
      digest: z.string(),
      length: z.number().int().nonnegative(),
      turnStartedAt: z.number().nullable(),
      rowId: z.string().nullable().optional()
    })
    .nullable()
})
type DisplayClear = z.infer<typeof clearSchema>
type Preview = { text: string | null; turnStartedAt: number | null }
const digest = (text: string) => bytesToHex(sha256(text))
const boundaries = new Map<string, DisplayClear | null>()
const pending = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
const keyFor = (identity: string) => `${chatTranscriptStoreKey(identity)}:display-clear`

function publish(identity: string, boundary: DisplayClear | null): void {
  setBoundedScopeCacheEntry(boundaries, identity, boundary, 8)
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function load(identity: string): void {
  if (boundaries.has(identity) || pending.has(identity)) {
    return
  }
  const store = readPageDeviceStore()
  const read = store?.available() ? store.read('cache', [keyFor(identity)]) : Promise.resolve(null)
  pending.set(
    identity,
    read
      .then(
        (result) => {
          const raw = result?.status === 'ok' ? result.values[0] : null
          const parsed = raw ? clearSchema.safeParse(decodeDeviceStoreValue(raw)) : null
          if (!boundaries.has(identity)) {
            publish(identity, parsed?.success ? parsed.data : null)
          }
        },
        () => {
          if (!boundaries.has(identity)) {
            publish(identity, null)
          }
        }
      )
      .finally(() => {
        pending.delete(identity)
      })
  )
}

export function mobileNativeChatDisplayBoundary(page: unknown): NativeChatMessage | null {
  return pageSchema.parse(page).messages.at(-1) ?? null
}

export async function clearMobileNativeChatDisplay(
  identity: string,
  message: NativeChatMessage | null,
  preview?: Preview
): Promise<void> {
  const boundary: DisplayClear = {
    row: message === null ? null : boundarySchema.parse(message),
    preview: preview?.text
      ? {
          digest: digest(preview.text),
          length: preview.text.length,
          turnStartedAt: preview.turnStartedAt
        }
      : null
  }
  await save(identity, boundary)
}

async function save(
  identity: string,
  boundary: DisplayClear,
  expected?: DisplayClear
): Promise<void> {
  if (expected && boundaries.get(identity) !== expected) {
    return
  }
  const store = readPageDeviceStore()
  if (store?.available()) {
    const result = await store.write('cache', [
      { key: keyFor(identity), value: encodeDeviceStoreValue(boundary) }
    ])
    if (!result.written) {
      throw new Error('chat_display_clear_not_saved')
    }
  }
  if (!expected || boundaries.get(identity) === expected) {
    publish(identity, boundary)
  }
}

export function mobileNativeChatMessagesAfterDisplayClear(
  messages: NativeChatMessage[],
  boundary: NativeChatMessage | null
): NativeChatMessage[] {
  return boundary === null
    ? messages
    : messages.filter((message) => {
        if (nativeChatSemanticRowId(message) === nativeChatSemanticRowId(boundary)) {
          return false
        }
        return message.transcriptOrder !== undefined && boundary.transcriptOrder !== undefined
          ? message.transcriptOrder > boundary.transcriptOrder
          : compareNativeChatTranscriptMessages(message, boundary) > 0
      })
}

export function useMobileNativeChatDisplayMessages(
  identity: string | null,
  messages: NativeChatMessage[],
  preview?: Preview
) {
  const read = useCallback(() => (identity === null ? null : boundaries.get(identity)), [identity])
  const boundary = useSyncExternalStore(subscribe, read, read)
  useEffect(() => {
    if (identity !== null) {
      load(identity)
    }
  }, [identity, boundary])
  const afterClear = useMemo(
    () =>
      boundary === undefined
        ? []
        : mobileNativeChatMessagesAfterDisplayClear(messages, boundary?.row ?? null),
    [messages, boundary]
  )
  const cut = boundary?.preview
  const previewRowId = useMemo(() => {
    if (!cut || cut.rowId !== undefined) {
      return cut?.rowId
    }
    for (const message of afterClear) {
      if (message.role === 'user') {
        if (
          cut.turnStartedAt !== null &&
          message.timestamp !== null &&
          message.timestamp <= cut.turnStartedAt
        ) {
          continue
        }
        return null
      }
      if (message.role === 'assistant' && previewPrefix(message, cut) !== null) {
        return message.id
      }
    }
    return undefined
  }, [afterClear, cut])
  useEffect(() => {
    if (
      identity === null ||
      !boundary?.preview ||
      boundary.preview.rowId !== undefined ||
      previewRowId === undefined
    ) {
      return
    }
    const resolved = { ...boundary, preview: { ...boundary.preview, rowId: previewRowId } }
    void save(identity, resolved, boundary).catch(() => {
      if (boundaries.get(identity) === boundary) {
        publish(identity, resolved)
      }
    })
  }, [identity, boundary, previewRowId])
  const shown = useMemo(() => {
    if (!cut || !previewRowId) {
      return afterClear
    }
    return afterClear.flatMap((message) => {
      if (message.id !== previewRowId) {
        return [message]
      }
      const prefix = previewPrefix(message, cut)
      if (prefix === null) {
        return [message]
      }
      let remaining = prefix
      const blocks: NativeChatMessage['blocks'] = []
      for (const block of message.blocks) {
        if (block.type !== 'text' || remaining === 0) {
          blocks.push(block)
          continue
        }
        const removed = Math.min(remaining, block.text.length)
        remaining -= removed
        const text = block.text.slice(removed).trimStart()
        if (text.trim()) {
          blocks.push({ ...block, text })
        }
      }
      return blocks.length ? [{ ...message, blocks }] : []
    })
  }, [afterClear, cut, previewRowId])
  let streaming = boundary === undefined ? null : (preview?.text ?? null)
  if (
    streaming &&
    cut &&
    preview?.turnStartedAt === cut.turnStartedAt &&
    digest(streaming.slice(0, cut.length)) === cut.digest
  ) {
    streaming = streaming.slice(cut.length).trimStart() || null
  }
  return {
    messages: shown,
    streaming,
    canLoadEarlier:
      boundary !== undefined &&
      (!boundary?.row || (messages.length > 0 && afterClear[0] === messages[0]))
  }
}

function previewPrefix(
  message: NativeChatMessage,
  cut: NonNullable<DisplayClear['preview']>
): number | null {
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
  const trimmed = text.trimStart()
  return digest(trimmed.slice(0, cut.length)) === cut.digest
    ? text.length - trimmed.length + cut.length
    : null
}
