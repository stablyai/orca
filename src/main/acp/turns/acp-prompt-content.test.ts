import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat/native-chat-types'
import { AcpPromptContentError, acpDispatchPrompt, acpPromptBlocks } from './acp-prompt-content'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const dir = mkdtempSync(join(tmpdir(), 'acp-prompt-content-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const pngPath = join(dir, 'shot.png')
writeFileSync(pngPath, PNG)

function message(...blocks: NativeChatBlock[]): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

async function refusal(body: AgentJournalMessageItem, images = true) {
  const error = await acpPromptBlocks(body, images).catch((caught: unknown) => caught)
  if (!(error instanceof AcpPromptContentError)) {
    throw new Error(`expected a refusal, got ${String(error)}`)
  }
  return error.failure
}

describe('ACP prompt content', () => {
  it('refuses a withheld command typed with arguments', async () => {
    const result = await acpDispatchPrompt(message({ type: 'text', text: '/allow-all on' }), {
      spec: { agent: 'copilot', dialect: { withheldCommands: ['allow-all'] } },
      connection: { initialize: async () => ({ protocolVersion: 1 }) }
    })
    expect(Array.isArray(result)).toBe(false)
  })

  it('keeps a host path when native encoding would exceed room reserved for later text', async () => {
    const path = join(dir, 'encoded.png')
    writeFileSync(path, Buffer.alloc(9 * 1024 * 1024))
    const text = 'x'.repeat(4 * 1024 * 1024)
    const blocks = await acpPromptBlocks(
      message({ type: 'image-ref', path }, { type: 'text', text }),
      true
    )
    expect(blocks).toEqual([
      { type: 'text', text: `@${path}` },
      { type: 'text', text }
    ])
    expect(Buffer.byteLength(JSON.stringify(blocks))).toBeLessThan(16 * 1024 * 1024 - 64 * 1024)
  })

  it('keeps a message with images within one protocol line', async () => {
    // Raw images fit, but their encoded payload plus text exceeds the protocol line limit.
    const text = 'x'.repeat(8 * 1024 * 1024)
    const image = {
      type: 'image-ref' as const,
      url: `data:image/png;base64,${PNG.toString('base64')}`
    }
    expect(
      await refusal(message({ type: 'text', text }, { type: 'text', text }, image))
    ).toMatchObject({
      attachment: { reason: 'totalTooLarge' }
    })
  })
})
