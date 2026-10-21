import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  ACP_PROMPT_IMAGE_MAX_BYTES,
  AcpPromptContentError,
  acpPromptBlocks
} from './acp-prompt-content'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const dir = mkdtempSync(join(tmpdir(), 'acp-prompt-content-'))
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
  it('sends text as text blocks', async () => {
    await expect(acpPromptBlocks(message({ type: 'text', text: 'hi' }), false)).resolves.toEqual([
      { type: 'text', text: 'hi' }
    ])
  })

  it('sends a file or data image as an ACP image block, in order', async () => {
    const data = PNG.toString('base64')
    await expect(
      acpPromptBlocks(
        message(
          { type: 'image-ref', path: pngPath },
          { type: 'text', text: 'what is this?' },
          { type: 'image-ref', url: pathToFileURL(pngPath).href },
          { type: 'image-ref', url: `data:image/png;base64,${data}` }
        ),
        true
      )
    ).resolves.toEqual([
      { type: 'image', mimeType: 'image/png', data },
      { type: 'text', text: 'what is this?' },
      { type: 'image', mimeType: 'image/png', data },
      { type: 'image', mimeType: 'image/png', data }
    ])
  })

  it('refuses an image when the agent takes none', async () => {
    expect(await refusal(message({ type: 'image-ref', path: pngPath }), false)).toMatchObject({
      kind: 'attachmentInvalid',
      attachment: { reason: 'unsupportedType' }
    })
  })

  it('refuses what it cannot read or send before anything leaves Orca', async () => {
    expect(await refusal(message({ type: 'image-ref', path: 'relative.png' }))).toMatchObject({
      attachment: { reason: 'noSource' }
    })
    expect(await refusal(message({ type: 'image-ref', path: join(dir, 'a.bmp') }))).toMatchObject({
      attachment: { reason: 'unsupportedType' }
    })
    expect(await refusal(message({ type: 'image-ref', path: `${dir}.png` }))).toMatchObject({
      kind: 'attachmentUnreadable'
    })
    expect(
      await refusal(message({ type: 'image-ref', url: 'data:image/svg+xml;base64,PHN2Zz4=' }))
    ).toMatchObject({ attachment: { reason: 'unsupportedType' } })
  })

  it('keeps a message with images within one protocol line', async () => {
    // The images fit their raw limit, but with this much text the prompt would pass the line.
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
    expect(ACP_PROMPT_IMAGE_MAX_BYTES * (4 / 3)).toBeLessThan(16 * 1024 * 1024)
  })

  it('leaves a text-only message to the agent, however long', async () => {
    const text = 'x'.repeat(9 * 1024 * 1024)
    await expect(
      acpPromptBlocks(message({ type: 'text', text }, { type: 'text', text }), true)
    ).resolves.toHaveLength(2)
  })

  it("bounds one message's images together", async () => {
    const big = Buffer.alloc(ACP_PROMPT_IMAGE_MAX_BYTES / 2 + 1).toString('base64')
    const image = { type: 'image-ref' as const, url: `data:image/png;base64,${big}` }
    expect(await refusal(message(image, image))).toMatchObject({
      attachment: { reason: 'totalTooLarge', limit: ACP_PROMPT_IMAGE_MAX_BYTES }
    })
  })
})
