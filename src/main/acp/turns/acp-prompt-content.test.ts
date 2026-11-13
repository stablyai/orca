import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat/native-chat-types'
import { AcpPromptContentError, acpPromptBlocks } from './acp-prompt-content'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const dir = mkdtempSync(join(tmpdir(), 'acp-prompt-content-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

  it('links mentioned files inside the session folder and keeps the text as typed', async () => {
    const root = join(dir, 'project')
    mkdirSync(join(root, 'my dir'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'my dir', 'b.txt'), 'b')
    writeFileSync(join(root, "it's.txt"), 'c')
    writeFileSync(join(root, 'report!'), 'd')
    writeFileSync(join(root, 'report'), 'e')
    // OpenCode 2 fails the whole turn for a linked file over 20 MiB.
    writeFileSync(join(root, 'big.log'), Buffer.alloc(20 * 1024 * 1024 + 1))
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(dir, 'outside', 'c.txt'), 'secret')
    // A junction needs no privilege on Windows.
    symlinkSync(join(dir, 'outside'), join(root, 'escape'), 'junction')
    const text =
      'Read @a.txt. and @"my dir/b.txt" @it\'s.txt, see:@report! not @../outside/c.txt @escape/c.txt @missing.txt @big.log'
    const real = realpathSync(root)

    expect(await acpPromptBlocks(message({ type: 'text', text }), true, root)).toEqual([
      { type: 'text', text },
      { type: 'resource_link', uri: pathToFileURL(join(real, 'a.txt')).href, name: 'a.txt' },
      {
        type: 'resource_link',
        uri: pathToFileURL(join(real, 'my dir', 'b.txt')).href,
        name: 'my dir/b.txt'
      },
      { type: 'resource_link', uri: pathToFileURL(join(real, "it's.txt")).href, name: "it's.txt" },
      { type: 'resource_link', uri: pathToFileURL(join(real, 'report!')).href, name: 'report!' }
    ])
  })
})
