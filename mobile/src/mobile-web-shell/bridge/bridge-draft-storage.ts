import { z } from 'zod'
import { utf8ByteLength } from './bridge-caps'
import {
  MOBILE_CHAT_DRAFT_CHUNK_CHARS,
  MOBILE_CHAT_DRAFT_MAX_BYTES,
  mobileChatDraftKeyScope,
  parseMobileChatDraft
} from '../../session/mobile-native-chat-draft-data'
import { onMobileChatDraftRemoval } from '../../session/mobile-native-chat-draft-storage'
import { pageRouteWorkspace } from '../page-storage-keys'

export const draftWriteParamsSchema = z.strictObject({
  key: z.string().min(1).max(1024),
  writeId: z.string().min(1).max(128),
  index: z.number().int().min(0).max(255),
  total: z.number().int().min(1).max(256),
  value: z.string().max(MOBILE_CHAT_DRAFT_CHUNK_CHARS).nullable()
})
export const draftWriteResultSchema = z.strictObject({ committed: z.boolean() })

export function pageMayAccessChatDraft(
  key: string,
  hostId: string,
  pathname: string,
  hostArea: boolean
): boolean {
  const scope = mobileChatDraftKeyScope(key)
  const workspace = pageRouteWorkspace(pathname)
  return (
    scope?.[0] === hostId &&
    (hostArea || (workspace?.hostId === hostId && workspace.worktreeId === scope[1]))
  )
}

/** One page session's bounded transfer; incomplete drafts own no durable work. */
export function createBridgeDraftWriter(args: {
  mayWrite(key: string): boolean
  check?(key: string): void
  commit(key: string, value: string | null): Promise<void>
  removeWorkspace(hostId: string, workspaceId: string): Promise<void>
}) {
  const pending = new Map<
    string,
    {
      writeId: string
      parts: string[]
      total: number
      bytes: number
      expires: ReturnType<typeof setTimeout>
    }
  >()
  const discard = (key: string) => {
    const held = pending.get(key)
    if (held) {
      clearTimeout(held.expires)
    }
    pending.delete(key)
  }
  let closed = false
  const unsubscribe = onMobileChatDraftRemoval((host, workspace) => {
    for (const key of pending.keys()) {
      const scope = mobileChatDraftKeyScope(key)
      if (scope?.[0] === host && (workspace === undefined || scope[1] === workspace)) {
        discard(key)
      }
    }
  })
  const check = (key?: string) => {
    if (closed) {
      throw new Error('This draft writer has ended')
    }
    if (key !== undefined) {
      args.check?.(key)
      if (!args.mayWrite(key)) {
        throw new Error('This page may not write that draft')
      }
    }
  }
  return {
    dispose: () => {
      closed = true
      unsubscribe()
      for (const key of pending.keys()) {
        discard(key)
      }
    },
    write: async (params: unknown): Promise<{ committed: boolean }> => {
      const part = draftWriteParamsSchema.parse(params)
      check(part.key)
      if (part.index === 0) {
        discard(part.key)
        if (pending.size >= 4) {
          throw new Error('Too many draft transfers')
        }
        pending.set(part.key, {
          writeId: part.writeId,
          parts: [],
          total: part.total,
          bytes: 0,
          expires: setTimeout(() => discard(part.key), 60_000)
        })
      }
      const held = pending.get(part.key)
      if (
        !held ||
        held.writeId !== part.writeId ||
        held.parts.length !== part.index ||
        held.total !== part.total
      ) {
        throw new Error('Draft transfer changed')
      }
      held.parts.push(part.value ?? '')
      held.bytes += utf8ByteLength(part.value ?? '')
      if (held.bytes > MOBILE_CHAT_DRAFT_MAX_BYTES) {
        discard(part.key)
        throw new Error('Draft is too large')
      }
      if (part.index + 1 !== part.total) {
        return { committed: false }
      }
      const value = part.value === null ? null : held.parts.join('')
      discard(part.key)
      const scope = mobileChatDraftKeyScope(part.key)
      if (value !== null && !parseMobileChatDraft(value)) {
        throw new Error('Invalid chat draft')
      }
      if (scope?.[2] === '') {
        if (value !== null || part.total !== 1) {
          throw new Error('Invalid draft removal')
        }
        await args.removeWorkspace(scope[0], scope[1])
        check()
      } else {
        await args.commit(part.key, value)
        check(part.key)
      }
      return { committed: true }
    }
  }
}
