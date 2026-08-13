import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import type { ClaudeSession } from './claude-structured-session-state'

function sessionFor(send = vi.fn().mockResolvedValue(undefined)): ClaudeSession {
  return {
    connection: { send } as unknown as ClaudeSession['connection'],
    providerSessionId: 'provider-session',
    leafUuid: null,
    fence: 1,
    prompts: {} as ClaudeSession['prompts'],
    dispatchWaiters: [],
    options: new Map(),
    reportedOptions: {},
    events: undefined,
    translator: null
  }
}

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

describe('Claude structured dispatch image limits', () => {
  it('rejects more than twenty URL images before sending', async () => {
    const session = sessionFor()
    const body = userMessage(
      Array.from({ length: 21 }, (_, index) => ({
        type: 'image-ref' as const,
        url: `https://example.test/${index}.png`
      }))
    )

    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
    ).resolves.toEqual({ state: 'rejected', reason: 'Claude messages support at most 20 images' })
    expect(session.connection.send).not.toHaveBeenCalled()
  })

  it('rejects local images whose aggregate size exceeds twenty MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-images-'))
    try {
      const paths = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const path = join(directory, `${index}.png`)
          await writeFile(path, Buffer.alloc(5 * 1024 * 1024))
          return path
        })
      )
      const session = sessionFor()
      const body = userMessage(paths.map((path) => ({ type: 'image-ref' as const, path })))

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude images must total no more than ${20 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a local image by actual bytes read beyond the per-image cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'oversized.png')
      await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1))
      const session = sessionFor()
      const body = userMessage([{ type: 'image-ref', path }])

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude image must be a non-empty file no larger than ${5 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
