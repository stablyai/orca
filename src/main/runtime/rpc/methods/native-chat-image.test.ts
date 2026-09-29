import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  NativeChatReadImage,
  NativeChatSession
} from '../../../../shared/rpc-contract/native-chat-params'
import { setNativeChatImageCacheDirForTests } from '../../../native-chat/transcript-image-cache'
import type { RpcContext } from '../core'

const cachedResult = vi.hoisted(() => {
  const messages: NativeChatMessage[] = []
  return { value: { messages } }
})
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: ({ limit }: { limit: number }) =>
    Promise.resolve({
      messages: cachedResult.value.messages.slice(-limit),
      hasMore: false,
      beforeOffset: 0
    }),
  subscribeNativeChatTranscript: () => Promise.resolve({ unsubscribe: () => {}, watching: true })
}))

import { NATIVE_CHAT_METHODS } from './native-chat'

function ctxWith(clientKind: RpcContext['clientKind']): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readSession and readImage never touch the runtime; the transcript reader is mocked above.
  return { runtime: {} as RpcContext['runtime'], clientKind }
}

function makeMessage(): NativeChatMessage {
  return { id: 'a-1', role: 'assistant', timestamp: 1, source: 'transcript', blocks: [] }
}

async function readSession(params: unknown, ctx: RpcContext): Promise<unknown> {
  const method = NATIVE_CHAT_METHODS.find((m) => m.name === 'nativeChat.readSession')
  if (!method) {
    throw new Error('readSession method not registered')
  }
  return method.handler(NativeChatSession.parse(params), ctx)
}

function firstImageRef(result: unknown): NativeChatBlock | undefined {
  if (!result || typeof result !== 'object' || !('messages' in result)) {
    return undefined
  }
  const { messages } = result
  return Array.isArray(messages) ? messages[0]?.blocks?.[0] : undefined
}

async function callReadImage(params: unknown, ctx: RpcContext): Promise<unknown> {
  const method = NATIVE_CHAT_METHODS.find((m) => m.name === 'nativeChat.readImage')
  if (!method) {
    throw new Error('readImage method not registered')
  }
  return method.handler(NativeChatReadImage.parse(params), ctx)
}

describe('nativeChat.readSession image hydration', () => {
  it('persists inline screenshot bytes and ships a cache path ref', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nnc-rpc-img-'))
    setNativeChatImageCacheDirForTests(cacheDir)
    try {
      const data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      cachedResult.value = {
        messages: [
          {
            id: 'shot-1',
            role: 'assistant',
            timestamp: 1_717_236_000_000,
            source: 'transcript',
            blocks: [{ type: 'image-ref', url: `data:image/png;base64,${data}` }]
          }
        ]
      }
      const result = await readSession({ agent: 'claude', sessionId: 's' }, ctxWith('mobile'))
      const block = firstImageRef(result)
      if (block?.type !== 'image-ref' || !block.path) {
        throw new Error('expected a hydrated image-ref path')
      }
      expect(block.url).toBeUndefined()
      expect(block.path.startsWith(cacheDir)).toBe(true)
      expect(readFileSync(block.path).toString('base64')).toBe(data)
    } finally {
      setNativeChatImageCacheDirForTests(undefined)
    }
  })

  it('serves a hydrated chat image back to a mobile client and nothing outside the cache', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nnc-rpc-read-image-'))
    setNativeChatImageCacheDirForTests(cacheDir)
    try {
      cachedResult.value = {
        messages: [
          {
            ...makeMessage(),
            blocks: [{ type: 'image-ref', url: `data:image/png;base64,${'a'.repeat(400)}` }]
          }
        ]
      }
      const mobile = { ...ctxWith('mobile'), requestId: 'req-1' }
      const result = await readSession({ agent: 'codex', sessionId: 's' }, mobile)
      const ref = firstImageRef(result)
      if (ref?.type !== 'image-ref' || !ref.path) {
        throw new Error('expected a cached path ref')
      }
      await expect(callReadImage({ path: ref.path }, mobile)).resolves.toEqual({
        content: 'a'.repeat(400),
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
      await expect(callReadImage({ path: '/etc/passwd' }, mobile)).rejects.toThrow(
        'image_not_found'
      )
    } finally {
      setNativeChatImageCacheDirForTests(undefined)
    }
  })
})
