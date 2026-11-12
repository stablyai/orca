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

  it('sends a host image up to 20 MiB inline and keeps a larger one as a path', async () => {
    const inlinePath = join(dir, 'photo.png')
    writeFileSync(inlinePath, Buffer.alloc(20 * 1024 * 1024))
    const [inline] = await acpPromptBlocks(message({ type: 'image-ref', path: inlinePath }), true)
    expect(inline).toMatchObject({ type: 'image', mimeType: 'image/png' })

    const largePath = join(dir, 'large.png')
    writeFileSync(largePath, Buffer.alloc(20 * 1024 * 1024 + 1))
    expect(await acpPromptBlocks(message({ type: 'image-ref', path: largePath }), true)).toEqual([
      { type: 'text', text: `@${largePath}` }
    ])
  })

  it('keeps a host path when native encoding would exceed room reserved for later text', async () => {
    const path = join(dir, 'encoded.png')
    writeFileSync(path, Buffer.alloc(18 * 1024 * 1024))
    const text = 'x'.repeat(8 * 1024 * 1024)
    const blocks = await acpPromptBlocks(
      message({ type: 'image-ref', path }, { type: 'text', text }),
      true
    )
    expect(blocks).toEqual([
      { type: 'text', text: `@${path}` },
      { type: 'text', text }
    ])
  })

  it('keeps a message with images within one protocol line', async () => {
    // The image fits its own budget, but the text around it overflows the protocol line.
    const text = 'x'.repeat(16 * 1024 * 1024)
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
