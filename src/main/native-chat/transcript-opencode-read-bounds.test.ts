import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  readOpenCodeNativeChatTranscriptFull,
  readOpenCodeNativeChatTranscriptTail
} from './transcript-opencode'

vi.mock('../managed-data-accounts/service', () => ({ getManagedDataAccountService: vi.fn() }))

describe('OpenCode full native read bounds', () => {
  it('counts reasoning, answer and image bytes cumulatively across pages', async () => {
    let calls = 0
    const chunk = 'x'.repeat(1_000_000)
    const messages: NativeChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      role: index % 2 === 0 ? 'reasoning' : 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'text', text: chunk }]
    }))
    messages.push({
      id: 'image',
      role: 'user',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'image-ref', url: `data:image/png;base64,${chunk}` }]
    })
    const result = await readOpenCodeNativeChatTranscriptFull('session', {
      resolveDbPath: async () => 'private-db',
      readPage: async () => ({
        items: messages.map((message) => ({ rowid: 100 - calls, fingerprint: '', message })),
        hasMore: true,
        beforeMessageRowId: 100 - ++calls
      })
    })
    expect(result).toEqual({ error: 'OpenCode transcript exceeds its full read limit' })
    expect(calls).toBe(6)
  })

  it.each(['tail', 'full'] as const)(
    'keeps cancellation attached to %s discovery and reads',
    async (kind) => {
      const controller = new AbortController()
      const resolveDbPath = vi.fn(async (_sessionId?: string, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal)
        return 'private-db'
      })
      const readPage = vi.fn(async (_args: unknown, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal)
        controller.abort(new Error('Cancelled private read'))
        signal?.throwIfAborted()
        return null
      })
      const deps = { resolveDbPath, readPage }
      const result =
        kind === 'tail'
          ? await readOpenCodeNativeChatTranscriptTail(
              { sessionId: 'session', limit: 1 },
              deps,
              controller.signal
            )
          : await readOpenCodeNativeChatTranscriptFull('session', deps, controller.signal)
      expect(result).toEqual({ error: 'Cancelled private read' })
      expect(readPage).toHaveBeenCalledOnce()
    }
  )
})
