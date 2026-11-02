import {
  selectRecoveryDelivery,
  withRecoveryContext
} from '../native-chat/agent-session-context-transfer-text'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { PiRpcPromptError, preparePiRpcPrompt } from './rpc-prompt'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  'base64'
)

function message(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

describe('Pi RPC prompt preparation', () => {
  it('encodes host-read image bytes and sends steer/followUp as prompt behavior', async () => {
    const readLocal = vi.fn(async () => PNG)
    const body = message([
      { type: 'text', text: 'Look at this' },
      { type: 'image-ref', path: '/workspace/screenshot.png' },
      { type: 'text', text: 'then reply' }
    ])
    expect(await preparePiRpcPrompt(body, 'steer', { readLocal })).toEqual({
      type: 'prompt',
      message: 'Look at this\nthen reply',
      streamingBehavior: 'steer',
      images: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }]
    })
    expect(readLocal).toHaveBeenCalledWith('/workspace/screenshot.png')
    expect(
      (await preparePiRpcPrompt(message([{ type: 'text', text: 'next' }]), 'followUp'))
        .streamingBehavior
    ).toBe('followUp')
  })

  it('budgets escaped historical context beside the actual encoded image prompt', async () => {
    const body = message([
      { type: 'text', text: 'Use "A" \\ B\nexactly' },
      { type: 'image-ref', path: '/workspace/image.png' }
    ])
    const before = structuredClone(body)
    const reads = { readLocal: async () => PNG }
    const original = await preparePiRpcPrompt(body, undefined, reads)
    const messages = Array.from({ length: 12 }, (_, sequence) => ({
      itemId: `history-${sequence}`,
      revision: 1,
      sequence,
      sequenceIndex: 0,
      role: 'assistant' as const,
      kind: 'message',
      text: 'quote " \\ newline\n'.repeat(200)
    }))
    const selection = selectRecoveryDelivery({
      id: 'encoded-delivery',
      capture: {
        selectionVersion: 1,
        messages,
        coverage: {
          eligibleCount: messages.length,
          omittedCount: 0,
          firstItemId: messages[0].itemId,
          lastItemId: messages.at(-1)!.itemId,
          inventoryDigest: 'inventory'
        }
      },
      body,
      encodedInputBytes: Buffer.byteLength(JSON.stringify(original)),
      encodedLimit: 8 * 1024 * 1024
    })
    const encoded = await preparePiRpcPrompt(
      withRecoveryContext(body, selection.encodedContext),
      undefined,
      reads
    )
    expect(selection.omittedCount).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(8 * 1024 * 1024)
    expect(encoded.images).toEqual(original.images)
    expect(encoded.message).toContain('User message:')
    expect(encoded.message).toContain('Use "A" \\ B\nexactly')
    expect(body).toEqual(before)
  })

  it('rejects URL refs with a typed unsupported attachment failure', async () => {
    const readLocal = vi.fn(async () => PNG)
    const rejected = await preparePiRpcPrompt(
      message([{ type: 'image-ref', url: 'https://example.test/image.png' }]),
      undefined,
      { readLocal }
    ).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(PiRpcPromptError)
    expect(rejected).toMatchObject({
      failure: { kind: 'attachmentInvalid', attachment: { reason: 'unsupportedType' } }
    })
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('checks local image MIME against bytes and rejects empty prompts', async () => {
    const readLocal = vi.fn(async () => PNG)
    await expect(
      preparePiRpcPrompt(message([{ type: 'image-ref', path: '/a.jpg' }]), undefined, { readLocal })
    ).rejects.toThrow()
    await expect(preparePiRpcPrompt(message([{ type: 'text', text: '' }]))).rejects.toThrow()
  })

  it('rejects a prompt beyond the RPC writer budget', async () => {
    const oversizedText = 'x'.repeat(32 * 1024 * 1024)
    await expect(
      preparePiRpcPrompt(message([{ type: 'text', text: oversizedText }]))
    ).rejects.toThrow('RPC write limit')
  })
})
