import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import {
  claudeDispatchInvokesSlashCommand,
  claudeDispatchMessageContent
} from './claude-structured-dispatch-content'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

const REMOTE_IMAGE = { type: 'image-ref' as const, url: 'https://example.test/a.png' }

describe('claudeDispatchMessageContent', () => {
  it('puts the text block last so a slash command still expands with an attachment', async () => {
    const content = await claudeDispatchMessageContent(
      // The composer builds text-then-images; Claude only treats a leading `/` as a
      // command when the LAST block is text.
      userMessage([{ type: 'text', text: '/goal ship the parser' }, REMOTE_IMAGE])
    )

    expect(content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
      { type: 'text', text: '/goal ship the parser' }
    ])
  })

  it('keeps every image ahead of the text and preserves each side’s order', async () => {
    const second = { type: 'image-ref' as const, url: 'https://example.test/b.png' }

    const content = await claudeDispatchMessageContent(
      userMessage([{ type: 'text', text: 'look' }, REMOTE_IMAGE, second])
    )

    expect(content.map((part) => (part as { type: string }).type)).toEqual([
      'image',
      'image',
      'text'
    ])
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.test/a.png' }
    })
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.test/b.png' }
    })
  })

  it('sends text alone unchanged', async () => {
    const content = await claudeDispatchMessageContent(userMessage([{ type: 'text', text: 'hi' }]))

    expect(content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('sends an image with no text', async () => {
    const content = await claudeDispatchMessageContent(userMessage([REMOTE_IMAGE]))

    expect(content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }
    ])
  })

  it('rejects a message with no renderable block', async () => {
    await expect(
      claudeDispatchMessageContent(userMessage([{ type: 'text', text: '' }]))
    ).rejects.toThrow('Claude dispatch requires text or an image')
  })

  it('rejects a non-user message', async () => {
    await expect(
      claudeDispatchMessageContent({
        ...userMessage([{ type: 'text', text: 'hi' }]),
        role: 'assistant'
      })
    ).rejects.toThrow('Claude dispatch accepts only user messages')
  })

  it('joins several text blocks so a command is not stranded ahead of trailing prose', async () => {
    // Appending each block would leave `thanks` trailing, and Claude reads only that block.
    const content = await claudeDispatchMessageContent(
      userMessage([
        { type: 'text', text: '/goal ship' },
        REMOTE_IMAGE,
        { type: 'text', text: 'thanks' }
      ])
    )

    expect(content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
      { type: 'text', text: '/goal ship\nthanks' }
    ])
    expect(claudeDispatchInvokesSlashCommand(content)).toBe(true)
  })

  it('puts a locally attached image ahead of the text, the shape the composer sends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-dispatch-content-'))
    const path = join(dir, 'shot.png')
    await writeFile(path, PNG)

    try {
      const content = await claudeDispatchMessageContent(
        userMessage([
          { type: 'text', text: '/goal ship' },
          { type: 'image-ref', path }
        ])
      )

      expect(content).toEqual([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') }
        },
        { type: 'text', text: '/goal ship' }
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('claudeDispatchInvokesSlashCommand', () => {
  it('reads the trailing prompt Claude recovers, not any text block', () => {
    expect(
      claudeDispatchInvokesSlashCommand([
        { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
        { type: 'text', text: '/goal ship' }
      ])
    ).toBe(true)
    // The pre-fix order: Claude recovers no prompt at all, so no command runs.
    expect(
      claudeDispatchInvokesSlashCommand([
        { type: 'text', text: '/goal ship' },
        { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }
      ])
    ).toBe(false)
  })

  it('reads the joined prompt, so a command behind leading prose is not one', async () => {
    // Keeping the blocks separate would leave `/goal ship` trailing and falsely claim a command.
    const content = await claudeDispatchMessageContent(
      userMessage([
        { type: 'text', text: 'take a look' },
        { type: 'text', text: '/goal ship' }
      ])
    )

    expect(content).toEqual([{ type: 'text', text: 'take a look\n/goal ship' }])
    expect(claudeDispatchInvokesSlashCommand(content)).toBe(false)
  })

  it('matches untrimmed, as Claude does, and ignores a promptless turn', () => {
    expect(claudeDispatchInvokesSlashCommand([{ type: 'text', text: '  /goal ship' }])).toBe(false)
    expect(claudeDispatchInvokesSlashCommand([{ type: 'text', text: 'ship it' }])).toBe(false)
    expect(claudeDispatchInvokesSlashCommand([])).toBe(false)
  })
})
