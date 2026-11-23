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
    // The journal worker checks the deadline against its own clock.
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
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

it('bounds two-pass recovery reads and stops decoding when the active item window fills', async () => {
  const c = await chat('batch')
  const message = (uuid: string, parentUuid: string | null, size = 800) => ({
    type: 'assistant',
    uuid,
    parentUuid,
    message: { content: uuid + 'x'.repeat(size) }
  })
  const rows = [
    { type: 'file-history-snapshot', data: 'p'.repeat(128 * 1024) },
    message('older', null),
    message('cutoff', 'older'),
    { type: 'progress', uuid: 'bridge', parentUuid: 'selected' },
    message('abandoned', null, 40 * 1024),
    message('selected', 'cutoff'),
    message('newest', 'bridge')
  ]
  await writeFile(c.filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const read = vi.spyOn(transcriptTail, 'readClaudeTranscriptWindow')
  const rawCap = 96 * 1024
  const itemBudget = 2400
  const imported = await importClaudeTranscript({
    agent: 'claude',
    filePath: c.filePath,
    sessionId: PROVIDER,
    limits: { inlineHeadBytes: 1024 },
    retainedBytes: itemBudget,
    maxBytes: rawCap,
    bounded: true
  })
  expect(imported.items.map(({ identity }) => identity)).toEqual([
    { provider: 'claude', sessionId: PROVIDER, uuid: 'selected' },
    { provider: 'claude', sessionId: PROVIDER, uuid: 'newest' }
  ])
  expect(imported.retainedBytes).toBeLessThanOrEqual(itemBudget + 4)
  const [links, payloads] = await Promise.all(read.mock.results.map(({ value }) => value))
  expect(read).toHaveBeenCalledTimes(2)
  expect(links.bytesRead + payloads.bytesRead).toBeLessThanOrEqual(2 * rawCap)
  expect(links.decodedBytes).toBeLessThanOrEqual(rawCap)
  expect(payloads.bytesRead).toBe(64 * 1024)
  expect(payloads.decodedBytes).toBeLessThan(3 * 1024)
})

// PR #45200: the reader without a visitor has a separate raw and decode budget.
it('reads and decodes a bounded recent window despite a large prefix', async () => {
  vi.useFakeTimers({ now: 0, toFake: ['Date'] })
  const c = await chat('batch')
  const prefix = `{"type":"progress","data":"${'x'.repeat(1024 * 1024)}"}\n`
  const newest =
    '{"type":"assistant","uuid":"newest","parentUuid":null,"message":{"content":"Newest answer"}}\n'
  await writeFile(c.filePath, prefix.repeat(30) + newest)
  const window = await transcriptTail.readClaudeTranscriptWindow({
    filePath: c.filePath,
    check: () => {}
  })
  expect(window.bytesRead).toBe(20_971_520)
  expect(window.decodedBytes).toBeLessThanOrEqual(20_971_520)
  expect(window.rows.at(-1)).toMatchObject({
    uuid: 'newest',
    message: { content: 'Newest answer' }
  })
})
