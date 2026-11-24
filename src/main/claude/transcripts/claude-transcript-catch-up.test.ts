import { afterEach, expect, it, vi } from 'vitest'
import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
import * as jsonlImport from '../../native-chat/agent-session-journal/history-import/journal-jsonl-import'
import { StructuredAgentSessionSnapshotRoutes } from '../../native-chat/agent-session-wire/host/structured-agent-session-snapshot-routes'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import {
  chat,
  closeClaudeCatchUpChats,
  PROVIDER,
  SESSION
} from './claude-transcript-catch-up.test-support'
import '../../native-chat/agent-session-journal/history-import/journal-claude-import-worker.test-fixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeClaudeCatchUpChats()
})

it.each<'tail' | 'batch' | 'metadata'>(['tail', 'batch', 'metadata'])(
  'shows newest outside history and discloses its retained window after exceeding the %s capacity',
  async (mode) => {
    const c = await chat(mode)
    if (mode === 'batch') {
      const prepare = jsonlImport.prepareJsonlTranscriptImport
      vi.spyOn(jsonlImport, 'prepareJsonlTranscriptImport').mockImplementationOnce(
        async (input) => {
          const prepared = await prepare(input)
          // Exercise an op-cap recovery whose retained window no longer reaches the saved leaf.
          return prepared.ok ? { ...prepared, items: prepared.items.slice(-100) } : prepared
        }
      )
    }
    const replacement = vi.fn()
    c.journal.epochReplacements.observe(replacement)
    const committed = vi.fn()
    c.journal.observeCommits(committed)
    expect(await c.catchUp()).toBe(true)
    expect(replacement).toHaveBeenCalledWith(expect.any(Promise))
    expect(committed).toHaveBeenCalledWith(
      expect.objectContaining({
        publication: expect.objectContaining({ resetPrompts: true })
      })
    )
    expect(c.publish).toHaveBeenCalled()
    const items = await c.items()
    expect(items).toContainEqual(
      expect.objectContaining({
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Distinctive newest outside answer' }]
        }
      })
    )
    expect(items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({ kind: 'status', presentation: 'continued-outside-recent' })
      })
    )
    // A reopen must use the imported coverage rather than replacing from the stale saved leaf again.
    const cursor = await c.journal.reads.physicalCursor()
    await c.reopen()
    expect(await c.catchUp()).toBe(true)
    expect(await c.journal.reads.physicalCursor()).toEqual(cursor)
    if (mode === 'metadata') {
      await c.appendOutsideAnswer()
      expect(await c.catchUp()).toBe(true)
      const continued = await c.items()
      expect(continued).toContainEqual(
        expect.objectContaining({
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Later outside answer' }]
          }
        })
      )
      expect(continued).not.toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({ presentation: 'continued-outside-rewound' })
        })
      )
    }
  }
)

it.each(['', 'x'.repeat(100 * 1024)])(
  'imports an equal-length final answer rewrite beyond a short frontier scan (%#)',
  async (padding) => {
    const c = await chat('batch')
    const transcript = await readFile(c.filePath, 'utf8')
    await writeFile(
      c.filePath,
      transcript.replace(
        'Distinctive newest outside answer',
        `Distinctive newest outside answer${padding}`
      )
    )
    expect(await c.catchUp()).toBe(true)
    const original = await readFile(c.filePath, 'utf8')
    const rewritten = original
      .replaceAll('newest-answer', 'edited-answer')
      .replace('Distinctive newest outside answer', 'Distinctive edited outside answer')
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
    await writeFile(c.filePath, rewritten)
    await c.reopen()
    expect(await c.catchUp()).toBe(true)
    expect(await c.items()).toContainEqual(
      expect.objectContaining({
        itemId: 'claude:provider-catch-up:edited-answer',
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [
            { type: 'text', text: expect.stringContaining('Distinctive edited outside answer') }
          ]
        }
      })
    )
  }
)

it('catches up from a newer saved leaf after growing past the recovery frontier', async () => {
  const c = await chat()
  expect(await c.catchUp()).toBe(true)
  await c.appendGrowth()
  await c.appendOutsideAnswer('saved-later-leaf')
  const cursor = await c.journal.reads.physicalCursor()
  await c.reopen()
  expect(await c.catchUp('saved-later-leaf')).toBe(true)
  expect((await c.journal.reads.physicalCursor()).epoch).toBe(cursor.epoch)
  const items = await c.items()
  expect(
    items.find(({ itemId }) => itemId === 'claude:provider-catch-up:saved-later-leaf')?.body
  ).toEqual({
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Rich saved later answer' }]
  })
  expect(items).toContainEqual(
    expect.objectContaining({
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Later outside answer' }]
      }
    })
  )
})

it('replaces recovered rows after a same-size rewrite that preserves the progress frontier', async () => {
  const c = await chat('metadata')
  expect(await c.catchUp()).toBe(true)
  const original = await readFile(c.filePath, 'utf8')
  const before = await stat(c.filePath)
  await writeFile(c.filePath, original.replace('newest outside answer', 'edited outside answer'))
  await utimes(c.filePath, before.atime, new Date(before.mtimeMs + 2000))
  await c.reopen()

  expect(await c.catchUp()).toBe(true)
  expect(
    (await c.items()).find(({ itemId }) => itemId === 'claude:provider-catch-up:newest-answer')
      ?.body
  ).toEqual({
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Distinctive edited outside answer' }]
  })
})

it('leaves an unchanged import with a UUID-less metadata suffix alone on reopen', async () => {
  const c = await chat('uuidless-metadata')
  expect(await c.catchUp()).toBe(true)
  const cursor = await c.journal.reads.physicalCursor()
  await c.reopen()
  expect(await c.catchUp()).toBe(true)
  expect(await c.journal.reads.physicalCursor()).toEqual(cursor)
})

it('replaces guarded catch-up coverage with a new legacy import origin', async () => {
  const c = await chat('batch')
  expect(await c.catchUp()).toBe(true)
  expect(await c.journal.reads.historyOrigin()).toMatchObject({
    raw: { kind: 'native_copy', sourceFrontier: 'newest-answer' }
  })
  await c.journal.write({
    kind: 'epoch-replace',
    reason: 'legacy_import',
    fence: 1,
    items: [
      {
        identity: { provider: 'claude', sessionId: PROVIDER, uuid: 'new-import' },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'New legacy import' }]
        },
        ownerFence: 1
      }
    ]
  })
  expect(await c.journal.reads.historyOrigin()).toMatchObject({
    raw: { kind: 'legacy_import' }
  })
})

it('holds snapshot reads during guarded recovery and resumes with the new history facts', async () => {
  const c = await chat('batch')
  await c.journal.appendItem(
    { provider: 'orca', clientMessageId: 'old-child' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Old child output' }] },
    {
      fence: 1,
      turnScope: { kind: 'thread' },
      agentId: 'old-agent',
      providerParentRef: 'old-tool',
      producerKind: 'agent',
      attempt: 0
    }
  )
  const routes = new StructuredAgentSessionSnapshotRoutes(createStructuredAgentSessionLogger())
  await c.deferred.followSnapshots(routes.observe(SESSION, c.journal))
  const { journalSnapshot, snapshotCurrent } = c.deferred.sink
  expect(journalSnapshot?.()?.canonicalByToolUse).toEqual([['old-tool', 'old-agent']])
  const duringReplacement = Promise.withResolvers<unknown>()
  c.journal.epochReplacements.observe((replaced) => {
    routes.replacing(SESSION, c.journal, replaced)
    duringReplacement.resolve(journalSnapshot?.())
  })
  expect(await c.catchUp()).toBe(true)
  expect(await duringReplacement.promise).toBeNull()
  await snapshotCurrent?.()
  expect(journalSnapshot?.()?.canonicalByToolUse).toEqual([])
})

it('continues a system frontier without reporting a rewind', async () => {
  const c = await chat('system')
  expect(await c.catchUp()).toBe(true)
  const cursor = await c.journal.reads.physicalCursor()
  await c.appendOutsideAnswer('system-frontier')
  await c.reopen()
  expect(await c.catchUp()).toBe(true)
  expect((await c.journal.reads.physicalCursor()).epoch).toBe(cursor.epoch)
  const items = await c.items()
  expect(items).toContainEqual(
    expect.objectContaining({
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Later outside answer' }]
      }
    })
  )
  expect(
    items.flatMap(({ body }) => (body.kind === 'status' ? [body.presentation] : []))
  ).not.toContain('continued-outside-rewound')
})

it.each(['claude', 'orca'])(
  'drops a replacement when %s output wins after the captured view',
  async (provider) => {
    const c = await chat()
    const replace = c.deferred.sink.tryReplaceHistory?.bind(c.deferred.sink)
    if (!replace) {
      throw new Error('missing production history replacement')
    }
    const replaced = vi.fn()
    c.journal.epochReplacements.observe(replaced)
    vi.spyOn(c.deferred.sink, 'tryReplaceHistory').mockImplementationOnce((replacement) => {
      c.deferred.sink.appendItem(
        provider === 'orca'
          ? { provider: 'orca', clientMessageId: 'concurrent' }
          : { provider: 'claude', sessionId: 'provider-catch-up', uuid: 'concurrent' },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Concurrent journal answer survives' }]
        },
        { turnScope: { kind: 'thread' } }
      )
      return replace(replacement)
    })
    expect(await c.catchUp()).toBe(false)
    const items = await c.items()
    expect(items).toContainEqual(
      expect.objectContaining({
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Concurrent journal answer survives' }]
        }
      })
    )
    expect(items).not.toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({ presentation: 'continued-outside-recent' })
      })
    )
    expect(replaced).toHaveBeenCalledWith(expect.any(Promise))
  }
)

it('leaves history and publication untouched when the replacement permit is revoked', async () => {
  const c = await chat()
  const replace = c.deferred.sink.tryReplaceHistory!.bind(c.deferred.sink)
  const replaced = vi.fn()
  c.journal.epochReplacements.observe(replaced)
  const committed = vi.fn()
  c.journal.observeCommits(committed)
  vi.spyOn(c.deferred.sink, 'tryReplaceHistory').mockImplementationOnce((replacement) => {
    Atomics.store(replacement.operation.guard.permit, 0, 0)
    return replace(replacement)
  })
  const cursor = await c.journal.reads.physicalCursor()
  expect(await c.catchUp()).toBe(false)
  expect(await c.journal.reads.physicalCursor()).toEqual(cursor)
  expect(replaced).toHaveBeenCalledWith(expect.any(Promise))
  expect(committed).not.toHaveBeenCalled()
  expect(c.publish).not.toHaveBeenCalled()
})

it.each([false, true])(
  'discloses an unprepared replacement once across repeated opens (earlier recovery: %s)',
  async (earlierRecovery) => {
    const c = await chat()
    if (earlierRecovery) {
      await c.journal.appendItem(
        {
          provider: 'legacy',
          agent: 'claude',
          sessionId: SESSION,
          recordId: 'continued-outside:capacity:provider-catch-up:old-leaf'
        },
        {
          kind: 'status',
          text: 'Earlier recovery notice',
          presentation: 'continued-outside-recent'
        },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    }
    vi.spyOn(jsonlImport, 'prepareJsonlTranscriptImport').mockResolvedValue({
      ok: false,
      error: 'unreadable transcript'
    })
    expect(await c.catchUp()).toBe(false)
    expect(await c.items()).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({ presentation: 'continued-outside-unloaded' })
      })
    )
    const cursor = await c.journal.reads.physicalCursor()
    await c.reopen()
    expect(await c.catchUp()).toBe(false)
    expect(await c.journal.reads.physicalCursor()).toEqual(cursor)
  }
)
