import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS,
  MOBILE_WEB_NATIVE_CHAT_READ_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS,
  MobileWebNativeChatReadResultSchema
} from '../../../../shared/mobile-web/native-chat-operation-contract'
import { boundMobileWebNativeChatRead } from './mobile-web-native-chat-read-budget'
import { windowForClient } from './native-chat-rpc-message-sanitizer'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

function message(id: string, blocks: unknown[]) {
  return { id, role: 'assistant', blocks, timestamp: 1, source: 'transcript' }
}

function sanitizedRead(messages: unknown[]) {
  return boundMobileWebNativeChatRead({
    messages: windowForClient(messages as NativeChatMessage[], 'mobile', messages.length),
    hasMore: false
  })
}

describe('native chat reads against the page contract', () => {
  it('keeps an adversarial transcript strictly parseable with every message intact', () => {
    const longId = 'x'.repeat(MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS + 976)
    const bounded = sanitizedRead([
      message('turn-text', [{ type: 'text', text: 'a'.repeat(100_000) }]),
      message(
        'turn-blocks',
        Array.from({ length: 200 }, (_, index) => ({ type: 'text', text: `block ${index}` }))
      ),
      message(longId, [{ type: 'text', text: 'hi' }])
    ])

    const parsed = MobileWebNativeChatReadResultSchema.safeParse(bounded)
    expect(parsed.success).toBe(true)
    expect(parsed.data?.messages).toHaveLength(3)
    expect(parsed.data?.messages.map((entry) => entry.id)).toEqual([
      'turn-text',
      'turn-blocks',
      'x'.repeat(MOBILE_WEB_NATIVE_CHAT_MESSAGE_ID_MAX_CHARACTERS)
    ])
  })

  it('shows a clipped text block instead of dropping it', () => {
    const bounded = sanitizedRead([
      message('turn-1', [{ type: 'text', text: 'a'.repeat(100_000) }])
    ]) as { messages: { blocks: { text: string }[] }[] }
    const text = bounded.messages[0].blocks[0].text

    expect(text).toHaveLength(MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS)
    expect(text.startsWith('a')).toBe(true)
    expect(text.endsWith('… (truncated)')).toBe(true)
  })

  it('keeps an over-count turn inside the block ceiling and marks the omission', () => {
    const bounded = sanitizedRead([
      message(
        'turn-1',
        Array.from({ length: 200 }, (_, index) => ({ type: 'text', text: `block ${index}` }))
      )
    ]) as { messages: { blocks: { text: string }[] }[] }
    const blocks = bounded.messages[0].blocks

    expect(blocks).toHaveLength(MOBILE_WEB_NATIVE_CHAT_MESSAGE_BLOCK_LIMIT)
    expect(blocks[0].text).toBe('block 0')
    expect(blocks.at(-1)?.text).toBe('\n… (truncated)')
  })

  it('bounds a tool name and drops an unresolvable image reference', () => {
    const bounded = sanitizedRead([
      message('turn-1', [
        { type: 'tool-call', name: 'N'.repeat(1000), input: {} },
        { type: 'image-ref', path: 'p'.repeat(9000), alt: 'ok' }
      ])
    ])

    expect(MobileWebNativeChatReadResultSchema.safeParse(bounded)).toMatchObject({ success: true })
    expect(JSON.parse(JSON.stringify(bounded)).messages[0].blocks).toEqual([
      {
        type: 'tool-call',
        name: 'N'.repeat(MOBILE_WEB_NATIVE_CHAT_TOOL_NAME_MAX_CHARACTERS),
        input: {}
      },
      { type: 'image-ref', alt: 'ok' }
    ])
  })

  it('never returns more messages than the page read limit accepts', () => {
    const bounded = boundMobileWebNativeChatRead({
      messages: Array.from({ length: MOBILE_WEB_NATIVE_CHAT_READ_LIMIT + 500 }, (_, index) =>
        message(`turn-${index}`, [{ type: 'text', text: 'hi' }])
      ),
      hasMore: true
    }) as { messages: unknown[] }

    expect(bounded.messages).toHaveLength(MOBILE_WEB_NATIVE_CHAT_READ_LIMIT)
    expect(MobileWebNativeChatReadResultSchema.safeParse(bounded)).toMatchObject({ success: true })
  })

  it('drops host-only block detail and block types the page cannot name', () => {
    const bounded = boundMobileWebNativeChatRead({
      messages: [
        message('turn-1', [
          {
            type: 'text',
            text: 'hi',
            providerFrame: { provider: 'claude', kind: 'raw', payload: {} }
          },
          { type: 'tool-result', output: 'out', editPatch: { filePath: 'a.ts', hunks: [] } },
          { type: 'future-block', field: 'dropped' }
        ])
      ],
      hasMore: false
    }) as { messages: { blocks: unknown[] }[] }

    expect(bounded.messages[0].blocks).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool-result', output: 'out' }
    ])
    expect(MobileWebNativeChatReadResultSchema.safeParse(bounded)).toMatchObject({ success: true })
  })

  it('does not mutate the host transcript it was given', () => {
    const source = {
      messages: [message('turn-1', [{ type: 'text', text: 'a'.repeat(100_000) }])],
      hasMore: false
    }
    boundMobileWebNativeChatRead(source)

    expect(source.messages[0].blocks[0]).toEqual({ type: 'text', text: 'a'.repeat(100_000) })
  })
})
