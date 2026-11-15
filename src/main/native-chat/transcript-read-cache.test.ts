import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isTextBlock } from '../../shared/native-chat/native-chat-types'
import {
  clearNativeChatTranscriptCache,
  readNativeChatTranscriptCached
} from './transcript-read-cache'

let tempRoots: string[] = []

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

beforeEach(() => {
  clearNativeChatTranscriptCache()
})

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('readNativeChatTranscriptCached', () => {
  it('never serves one file’s parse for a different file that shares a sessionId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-cache-xwt-'))
    tempRoots.push(root)
    const fileA = join(root, 'worktree-a.jsonl')
    const fileC = join(root, 'worktree-c.jsonl')
    await writeFile(
      fileA,
      jsonLines([
        {
          type: 'user',
          uuid: 'a0',
          timestamp: '2026-06-01T10:00:00.000Z',
          message: { role: 'user', content: 'from-worktree-A' }
        }
      ])
    )
    await writeFile(
      fileC,
      jsonLines([
        {
          type: 'user',
          uuid: 'c0',
          timestamp: '2026-06-01T10:00:00.000Z',
          message: { role: 'user', content: 'from-worktree-C' }
        }
      ])
    )
    // Equal mtimes expose session-ID collisions that timestamp invalidation would otherwise hide.
    const when = new Date('2026-06-01T10:00:00.000Z')
    await utimes(fileA, when, when)
    await utimes(fileC, when, when)

    const readText = (
      result: Awaited<ReturnType<typeof readNativeChatTranscriptCached>>
    ): string =>
      'messages' in result
        ? result.messages
            .flatMap((message) => message.blocks)
            .filter(isTextBlock)
            .map((block) => block.text)
            .join(' ')
        : ''

    const a = await readNativeChatTranscriptCached('claude', 'shared-session', fileA)
    const c = await readNativeChatTranscriptCached('claude', 'shared-session', fileC)

    expect(readText(a)).toContain('from-worktree-A')
    expect(readText(c)).toContain('from-worktree-C')
    expect(readText(c)).not.toContain('from-worktree-A')
    expect(c).not.toBe(a)
  })
})
