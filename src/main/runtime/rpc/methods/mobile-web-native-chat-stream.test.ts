import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
const subscribe = vi.hoisted(() => vi.fn())
vi.mock('./native-chat', async () => {
  const { z } = await import('zod')
  return {
    NATIVE_CHAT_METHODS: [
      {
        name: 'nativeChat.subscribe',
        stream: true,
        params: z.object({}).passthrough(),
        handler: subscribe
      }
    ]
  }
})
import { MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD } from './mobile-web-native-chat-stream'

function fixture() {
  const providerSession = { id: 'provider', transcriptPath: '/private/transcript' }
  const current = { worktreeId: 'workspace', agent: 'codex', providerSession }
  const runtime = {
    listMobileSessionTabs: vi.fn().mockResolvedValue({
      worktree: 'workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      tabs: [
        {
          id: 'tab',
          type: 'terminal',
          terminal: 'terminal',
          agentStatus: { agentType: 'codex', providerSession }
        }
      ]
    }),
    resolveNativeChatTranscriptBinding: vi.fn().mockReturnValue(current),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn()
  }
  const context = { runtime, connectionId: 'connection' } as unknown as RpcContext
  const params = {
    worktree: 'id:workspace',
    tabId: 'tab',
    sessionId: 'provider',
    read: { limit: 20, subscriptionId: 'forged' }
  }
  return { runtime, context, params }
}
beforeEach(() => subscribe.mockReset())
describe('opaque native-chat feed', () => {
  it.each(['snapshot', 'appended', 'replaced'])(
    'bounds large %s events and keeps the feed open',
    async (type) => {
      const f = fixture()
      let publish!: (event: unknown) => void
      subscribe.mockImplementationOnce(async (_params, _context, emit) => {
        publish = emit
      })
      const emit = vi.fn()
      await MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD.handler(f.params, f.context, emit)
      const messages = Array.from({ length: 8 }, (_, index) => ({
        id: `message-${index}`,
        blocks: [{ type: 'text', text: '界'.repeat(64_000), providerFrame: { kind: 'raw' } }]
      }))
      publish({ type, messages, hasMore: true, beforeOffset: 42, futureLifecycle: 'new' })
      publish({ type: 'appended', messages: [] })
      const result = emit.mock.calls[1][0]
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024)
      expect(result).toMatchObject({ type, hasMore: true, beforeOffset: 42 })
      expect(result).not.toHaveProperty('futureLifecycle')
      expect(result.messages).toHaveLength(8)
      expect(result.messages[0].blocks[0]).toEqual({
        type: 'text',
        text: expect.stringContaining('(truncated)')
      })
      expect(emit.mock.calls[2][0]).toEqual({ type: 'appended', messages: [] })
      expect(f.runtime.cleanupSubscription).not.toHaveBeenCalled()
    }
  )

  it('closes and cleans up once when identity metadata alone exceeds the response budget', async () => {
    const f = fixture()
    let publish!: (event: unknown) => void
    subscribe.mockImplementationOnce(async (_params, _context, emit) => {
      publish = emit
    })
    const emit = vi.fn()
    await MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD.handler(f.params, f.context, emit)
    publish({
      type: 'snapshot',
      messages: Array.from({ length: 1_000 }, (_, index) => ({
        id: `${index}`.padEnd(1_024, 'x'),
        blocks: []
      }))
    })
    publish({ type: 'appended', messages: [] })
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['ready', 'error'])
    expect(f.runtime.cleanupSubscription).toHaveBeenCalledOnce()
  })

  it('announces a private cleanup token and forwards the page-shaped event', async () => {
    const f = fixture()
    const event = { type: 'snapshot', messages: [], hasMore: false, pending: true }
    subscribe.mockImplementationOnce(async (_params, _context, emit) => emit(event))
    const emit = vi.fn()
    await MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD.handler(f.params, f.context, emit)
    const ready = emit.mock.calls[0][0]
    expect(ready).toMatchObject({ type: 'ready', subscriptionId: expect.any(String) })
    expect(ready.subscriptionId).not.toBe('forged')
    expect(ready.subscriptionId).not.toContain('provider')
    expect(emit.mock.calls[1]).toEqual([event])
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'provider',
        terminal: 'terminal',
        worktreeId: 'workspace',
        subscriptionId: ready.subscriptionId
      }),
      f.context,
      expect.any(Function)
    )
  })

  it('closes once without publishing after its provider binding changes', async () => {
    const f = fixture()
    let publish!: (event: unknown) => void
    subscribe.mockImplementationOnce(async (_params, _context, emit) => {
      publish = emit
    })
    const emit = vi.fn()
    await MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD.handler(f.params, f.context, emit)
    f.runtime.resolveNativeChatTranscriptBinding.mockReturnValue(null)
    publish({ type: 'appended', messages: [{ secret: 'wrong-session' }] })
    publish({ type: 'appended', messages: [] })
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['ready', 'error'])
    expect(JSON.stringify(emit.mock.calls)).not.toContain('wrong-session')
    expect(f.runtime.cleanupSubscription).toHaveBeenCalledOnce()
  })

  it('does not publish the initial snapshot after cancellation inside ready delivery', async () => {
    const f = fixture()
    const received: unknown[] = []
    let publish!: (event: unknown) => void
    subscribe.mockImplementationOnce(async (_params, _context, emit) => {
      publish = emit
      emit({ type: 'snapshot', messages: [] })
    })
    await MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD.handler(f.params, f.context, (event) => {
      received.push(event)
      if ((event as { type: string }).type === 'ready') {
        publish({ type: 'end' })
      }
    })
    expect(received).toEqual([
      { type: 'ready', subscriptionId: expect.any(String) },
      { type: 'end' }
    ])
  })
  it('cleans up a watcher when native setup fails after registration', async () => {
    const f = fixture()
    subscribe.mockRejectedValueOnce(new Error('Watcher setup failed'))
    await expect(
      MOBILE_WEB_NATIVE_CHAT_STREAM_METHOD.handler(f.params, f.context, vi.fn())
    ).rejects.toThrow('Watcher setup failed')
    expect(f.runtime.cleanupSubscription).toHaveBeenCalledOnce()
  })
})
