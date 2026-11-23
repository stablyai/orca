import { afterEach, expect, it, vi } from 'vitest'
import { stat, utimes, writeFile } from 'node:fs/promises'
import * as capacityRecovery from './claude-transcript-capacity-recovery'
import * as transcriptTail from './claude-transcript-tail'
import { importClaudeTranscript } from '../../native-chat/agent-session-journal/history-import/journal-claude-import'
import { catchUpClaudeTranscript } from './claude-transcript-catch-up'
import {
  chat,
  closeClaudeCatchUpChats,
  PROVIDER,
  SESSION
} from './claude-transcript-catch-up.test-support'

// PR #45200: a non-item suffix beyond the raw cap must not recover again on unchanged reopen.
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await closeClaudeCatchUpChats()
})

it.each<'metadata' | 'uuidless-metadata'>(['metadata', 'uuidless-metadata'])(
  'recovers once across opens with a %s suffix beyond the raw cap',
  async (mode) => {
    const c = await chat('batch')
    const suffix = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({
        type: mode === 'metadata' ? 'progress' : 'file-history-snapshot',
        ...(mode === 'metadata' ? { uuid: `progress-${index}` } : {}),
        data: 'x'.repeat(1024)
      })
    )
    const oldLeaf =
      '{"type":"assistant","uuid":"old-leaf","parentUuid":null,"message":{"content":"old answer"}}'
    await writeFile(c.filePath, `${oldLeaf}\n${suffix.join('\n')}\n`)
    const recovery = vi.spyOn(capacityRecovery, 'prepareClaudeTranscriptCapacityRecovery')
    const input = {
      sessionId: SESSION,
      providerSessionId: PROVIDER,
      leafUuid: 'old-leaf',
      claudeConfigDir: c.config,
      cwd: c.cwd,
      sink: c.deferred.sink,
      maxBytes: 4096
    }

    expect(await catchUpClaudeTranscript(input)).toEqual({
      kind: 'capacity',
      deadline: expect.any(Number)
    })
    expect(await catchUpClaudeTranscript({ ...input, mode: 'recovery' })).toBe(false)
    expect(recovery).toHaveBeenCalledTimes(1)
    const items = await c.items()
    expect(items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'status',
          presentation: 'continued-outside-unloaded'
        })
      })
    )
    expect(items).toContainEqual(
      expect.objectContaining({
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'old answer' }] }
      })
    )

    recovery.mockClear()
    await c.reopen()
    expect(await catchUpClaudeTranscript(input)).toBe(true)
    expect(recovery).toHaveBeenCalledTimes(0)

    if (mode === 'uuidless-metadata') {
      const before = await stat(c.filePath)
      const rewritten = [...suffix]
      // The new row is beyond the frontier probe but within the larger recovery window.
      rewritten[5] = JSON.stringify({
        type: 'user',
        uuid: 'rewritten-message',
        parentUuid: null,
        message: { content: 'Recovered from a same-size rewrite' }
      }).padEnd(suffix[5]!.length)
      await writeFile(c.filePath, `${oldLeaf}\n${rewritten.join('\n')}\n`)
      await utimes(c.filePath, before.atime, new Date(before.mtimeMs + 2000))
      expect((await stat(c.filePath)).size).toBe(before.size)

      await c.reopen()
      expect(await catchUpClaudeTranscript(input)).toEqual({
        kind: 'capacity',
        deadline: expect.any(Number)
      })
      expect(
        await catchUpClaudeTranscript({ ...input, mode: 'recovery', maxBytes: 12 * 1024 })
      ).toBe(true)
      expect(await c.items()).toContainEqual(
        expect.objectContaining({
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Recovered from a same-size rewrite' }]
          }
        })
      )
    }
  }
)

// PR #45200: filling the item window stops raw reads only after its active chain is linked.
it.each([
  { parentUuid: null, bytesRead: 65536 },
  { parentUuid: 'missing-parent', bytesRead: 98304 }
])(
  'bounds a full item window with cutoff parent $parentUuid',
  async ({ parentUuid, bytesRead }) => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] })
    const c = await chat('batch')
    const message = (uuid: string, parentUuid: string | null) => ({
      type: 'assistant',
      uuid,
      parentUuid,
      message: { content: `${uuid}${'x'.repeat(800)}` }
    })
    const suffix = [
      message('cutoff', parentUuid),
      { type: 'progress', uuid: 'bridge', parentUuid: 'selected' },
      message('abandoned', null),
      message('selected', 'cutoff'),
      message('newest', 'bridge')
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')
    await writeFile(
      c.filePath,
      `{"type":"file-history-snapshot","data":"${'p'.repeat(128 * 1024)}"}\n${suffix}\n`
    )
    const read = vi.spyOn(transcriptTail, 'readClaudeTranscriptWindow')
    const imported = await importClaudeTranscript({
      filePath: c.filePath,
      sessionId: PROVIDER,
      limits: { inlineHeadBytes: 1024 },
      retainedBytes: 2400,
      maxBytes: 98304,
      bounded: true
    })
    expect(imported.items.map(({ identity }) => identity)).toEqual([
      { provider: 'claude', sessionId: PROVIDER, uuid: 'selected' },
      { provider: 'claude', sessionId: PROVIDER, uuid: 'newest' }
    ])
    const result = read.mock.results[0]
    if (result.type !== 'return') {
      throw new Error('missing transcript window read')
    }
    expect((await result.value).bytesRead).toBe(bytesRead)
  }
)
