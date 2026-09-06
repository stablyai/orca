import { describe, expect, it } from 'vitest'
import {
  MobileWebNativeChatReadResultSchema,
  MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS
} from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { projectMobileWebNativeChatMessages } from './mobile-web-native-chat-message-projection'

function hostMessage(blocks: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-1',
    role: 'assistant',
    timestamp: 1_720_000_000_000,
    source: 'transcript',
    blocks,
    ...overrides
  }
}

function projectedBlocks(blocks: unknown[]): unknown[] {
  const messages = projectMobileWebNativeChatMessages([hostMessage(blocks)])
  expect(MobileWebNativeChatReadResultSchema.safeParse({ messages, hasMore: false }).success).toBe(
    true
  )
  return messages?.[0]?.blocks ?? []
}

describe('mobile web native chat message projection', () => {
  it('keeps a message the host enriched past this wire instead of failing the transcript', () => {
    expect(
      projectedBlocks([
        { type: 'tool-result', output: 'done', editPatch: { filePath: 'a.ts', hunks: [] } },
        {
          type: 'text',
          text: 'Ready',
          providerFrame: {
            provider: 'claude',
            kind: 'unhandled',
            payload: { head: 'h', byteLength: 1, digest: 'd', truncated: false }
          }
        }
      ])
    ).toEqual([
      { type: 'tool-result', output: 'done' },
      { type: 'text', text: 'Ready' }
    ])
  })

  it('truncates text the host caps far above this wire rather than refusing it', () => {
    const blocks = projectedBlocks([{ type: 'text', text: 'x'.repeat(64_000) }])

    const text = (blocks[0] as { text: string }).text
    expect(text.length).toBe(MOBILE_WEB_NATIVE_CHAT_BLOCK_TEXT_MAX_CHARACTERS)
    expect(text.endsWith('… (truncated)')).toBe(true)
  })

  it('carries the tool-call lifecycle state and drops one it cannot name', () => {
    expect(
      projectedBlocks([
        { type: 'tool-call', name: 'Bash', input: { command: 'ls' }, state: 'running' },
        { type: 'tool-call', name: 'Bash', input: {}, state: 'queued' }
      ])
    ).toEqual([
      { type: 'tool-call', name: 'Bash', input: { command: 'ls' }, state: 'running' },
      { type: 'tool-call', name: 'Bash', input: {} }
    ])
  })

  it('still bounds tool-call input', () => {
    const blocks = projectedBlocks([
      { type: 'tool-call', name: 'Bash', input: { command: 'y'.repeat(20_000) } }
    ])

    expect(JSON.stringify(blocks).length).toBeLessThan(8_000)
  })

  it('drops a block whose shape the page cannot render, keeping its siblings', () => {
    expect(
      projectedBlocks([
        { type: 'thinking', text: 'hmm' },
        { type: 'text', text: 'Ready' }
      ])
    ).toEqual([{ type: 'text', text: 'Ready' }])
  })

  it('drops a message whose id would break dedup rather than clipping it', () => {
    const messages = projectMobileWebNativeChatMessages([
      hostMessage([{ type: 'text', text: 'a' }], { id: 'i'.repeat(1025) }),
      hostMessage([{ type: 'text', text: 'b' }], { id: 'message-2' })
    ])

    expect(messages?.map((message) => message.id)).toEqual(['message-2'])
  })

  it('refuses a reply whose messages are not a list', () => {
    expect(projectMobileWebNativeChatMessages({ messages: [] })).toBeNull()
    expect(projectMobileWebNativeChatMessages(undefined)).toBeNull()
  })

  it('projects an adversarial corpus into something the contract always accepts', () => {
    const messages = projectMobileWebNativeChatMessages([
      hostMessage(Array.from({ length: 200 }, () => ({ type: 'text', text: 'x'.repeat(9_000) }))),
      hostMessage([null, 7, 'text', { type: 'image-ref', path: 'p'.repeat(5_000), alt: 'a' }]),
      hostMessage([], { timestamp: Number.NaN, turnId: '', source: 'unknown-source' }),
      hostMessage([], { timestamp: Number.POSITIVE_INFINITY, blocks: 'not-a-list' })
    ])

    expect(
      MobileWebNativeChatReadResultSchema.safeParse({ messages, hasMore: false }).success
    ).toBe(true)
  })
})
