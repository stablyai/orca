import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeChatPageFixture as fixture } from './mobile-web-native-chat-test-fixture'
import { MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES } from '../../../../shared/mobile-web/native-chat-operation-contract'
const read = vi.hoisted(() => vi.fn())
vi.mock('./native-chat', async () => {
  const { z } = await import('zod')
  return {
    NATIVE_CHAT_METHODS: [
      { name: 'nativeChat.readSession', params: z.object({}).passthrough(), handler: read }
    ]
  }
})
import { MOBILE_WEB_NATIVE_CHAT_METHODS } from './mobile-web-native-chat'
const reader = MOBILE_WEB_NATIVE_CHAT_METHODS[0]
beforeEach(() => read.mockReset())
describe('Desktop native-chat page adapter', () => {
  it.each(['界', '\u0000'])(
    'keeps large %s transcripts readable within the bridge byte ceiling',
    async (character) => {
      const f = fixture()
      const messages = Array.from({ length: 8 }, (_, index) => ({
        id: `message-${index}`,
        role: 'assistant',
        source: 'transcript',
        timestamp: index,
        blocks: [{ type: 'text', text: character.repeat(64_000), providerFrame: { kind: 'raw' } }]
      }))
      const raw = { messages, hasMore: true, beforeOffset: 42, futureLifecycle: 'new' }
      read.mockResolvedValue(raw)
      const result = (await reader.handler(
        { ...f.scope, read: { limit: 8, beforeOffset: 100 } },
        f.context
      )) as typeof raw
      expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(
        MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES
      )
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES
      )
      expect(result).toMatchObject({ hasMore: true, beforeOffset: 42 })
      expect(result).not.toHaveProperty('futureLifecycle')
      expect(result.messages.map(({ id }) => id)).toEqual(messages.map(({ id }) => id))
      for (const message of result.messages) {
        expect(message.blocks[0]).not.toHaveProperty('providerFrame')
        expect(message.blocks[0].text).toContain('(truncated)')
        expect(message.blocks[0].text.startsWith(character)).toBe(true)
      }
      expect(raw.messages[0].blocks[0].text).toHaveLength(64_000)
    }
  )

  it('bounds oversized tool blocks without discarding messages or the pagination cursor', async () => {
    const f = fixture()
    const raw = {
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `message-${index}`,
        blocks: [
          { type: 'image-ref', alt: 'kept' },
          { type: 'tool-call', name: 'Bash', input: { payload: 'x'.repeat(100_000) } }
        ]
      })),
      hasMore: true,
      beforeOffset: 123
    }
    read.mockResolvedValue(raw)
    const result = (await reader.handler({ ...f.scope, read: {} }, f.context)) as typeof raw
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES
    )
    expect(result.messages).toHaveLength(40)
    expect(result.beforeOffset).toBe(123)
    expect(result.messages[0].blocks).toEqual([
      { type: 'image-ref', alt: 'kept' },
      { type: 'text', text: '\n… (truncated)' }
    ])
  })

  it('reads host identities from the tab list and ignores forged read fields', async () => {
    const f = fixture()
    read.mockResolvedValue({ messages: [{ id: 'message-1' }], futureLifecycle: 'new' })
    expect(
      await reader.handler(
        {
          ...f.scope,
          read: {
            limit: 30,
            sessionId: 'forged',
            transcriptPath: '/forged',
            worktreeId: 'forged',
            terminal: 'forged'
          }
        },
        f.context
      )
    ).toEqual({ messages: [{ id: 'message-1' }] })
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 30,
        agent: 'codex',
        sessionId: 'provider-session',
        transcriptPath: '/private/transcript',
        terminal: 'host-terminal',
        worktreeId: 'host-workspace'
      }),
      f.context
    )
  })

  it.each([
    ['a session the tab no longer reports', { id: 'replacement-session' }],
    ['a tab with no live agent session', undefined]
  ])('refuses %s before reading', async (_name, providerSession) => {
    const f = fixture()
    f.listMobileSessionTabs.mockResolvedValue({
      worktree: 'host-workspace',
      tabs: [{ ...f.tab, agentStatus: { agentType: 'codex', providerSession } }]
    })
    await expect(reader.handler({ ...f.scope, read: {} }, f.context)).rejects.toThrow(
      'selector_not_found'
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('fails the read instead of forwarding an unreachable-transcript result', async () => {
    const f = fixture()
    read.mockResolvedValue({ error: 'Transcript unavailable' })
    await expect(reader.handler({ ...f.scope, read: { limit: 8 } }, f.context)).rejects.toThrow(
      'runtime_unavailable'
    )
  })

  it('reads again after an unverifiable snapshot failure', async () => {
    const f = fixture()
    f.listMobileSessionTabs.mockRejectedValueOnce(new Error('Connection unavailable'))
    await expect(reader.handler({ ...f.scope, read: {} }, f.context)).rejects.toThrow(
      'Connection unavailable'
    )
    read.mockResolvedValueOnce({ messages: [] })
    expect(await reader.handler({ ...f.scope, read: {} }, f.context)).toEqual({ messages: [] })
  })
})
