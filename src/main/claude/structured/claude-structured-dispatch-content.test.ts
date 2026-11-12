import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeDispatchMessageContent } from './claude-structured-dispatch-content'

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

const REMOTE_IMAGE = { type: 'image-ref' as const, url: 'https://example.test/a.png' }

describe('claudeDispatchMessageContent', () => {
  it('puts the text block last so a slash command still expands with an attachment', async () => {
    const content = await claudeDispatchMessageContent(
      userMessage([{ type: 'text', text: '/goal ship the parser' }, REMOTE_IMAGE])
    )

    expect(content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
      { type: 'text', text: '/goal ship the parser' }
    ])
  })

  it('sends a local image over the API per-image limit for Claude to shrink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'retina-screenshot.png')
      await writeFile(path, Buffer.alloc(6 * 1024 * 1024, 1))

      const content = await claudeDispatchMessageContent(userMessage([{ type: 'image-ref', path }]))

      expect(content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.alloc(6 * 1024 * 1024, 1).toString('base64')
          }
        }
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
