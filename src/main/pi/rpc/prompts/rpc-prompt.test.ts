import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { PiRpcPromptError, preparePiRpcPrompt } from './rpc-prompt'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  'base64'
)

function message(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

describe('Pi RPC prompt preparation', () => {
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

  it('rejects a prompt beyond the RPC writer budget', async () => {
    const oversizedText = 'x'.repeat(32 * 1024 * 1024)
    await expect(
      preparePiRpcPrompt(message([{ type: 'text', text: oversizedText }]))
    ).rejects.toThrow('RPC write limit')
  })
})
