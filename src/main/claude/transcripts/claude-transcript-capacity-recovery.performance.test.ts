import { afterEach, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { stat, utimes, writeFile } from 'node:fs/promises'
import * as capacityRecovery from './claude-transcript-capacity-recovery'
import * as transcriptTail from './claude-transcript-tail'
import * as claudeImport from '../../native-chat/agent-session-journal/history-import/journal-claude-import'
import * as payloadBounds from '../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import { catchUpClaudeTranscript } from './claude-transcript-catch-up'
import { claudeSourceBlockId } from '../structured/journal/claude-streamed-block-identity'
import '../../native-chat/agent-session-journal/history-import/journal-claude-import-worker.test-fixture'
import {
  claudeImportWorkerEntry,
  setClaudeImportWorkerEntry
} from '../../native-chat/agent-session-journal/history-import/journal-claude-import-worker'
import {
  chat,
  closeClaudeCatchUpChats,
  PROVIDER,
  SESSION
} from './claude-transcript-catch-up.test-support'

// ESM namespaces cannot be spied on; wrap streams and handles to count what the importer reads.
const sourceStreams = vi.hoisted((): NodeFs.ReadStream[] => [])
const handleReads = vi.hoisted(() => ({ bytes: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const read = handle.read.bind(handle)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards every argument and result of the real read unchanged.
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs)
        handleReads.bytes += result.bytesRead
        return result
      }) as typeof handle.read
      return handle
    }
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      sourceStreams.push(stream)
      return stream
    }
  }
})

// PR #45200: a non-item suffix beyond the raw cap must not recover again on unchanged reopen.
afterEach(async () => {
  sourceStreams.length = 0
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

it('persists the recovery receipt across reopen', async () => {
  const c = await chat('batch')
  await writeFile(
    c.filePath,
    [
      '{"type":"assistant","uuid":"old-leaf","message":{"content":"Old answer"}}',
      ...Array.from({ length: 12 }, (_, index) => `{"type":"progress","uuid":"noise-${index}"}`),
      '{"type":"user","uuid":"new-question","parentUuid":"old-leaf","message":{"content":"New question"}}',
      '{"type":"assistant","uuid":"new-answer","parentUuid":"new-question","message":{"content":"New answer"}}',
      ''
    ].join('\n')
  )
  const input = {
    sessionId: SESSION,
    providerSessionId: PROVIDER,
    leafUuid: 'old-leaf',
    claudeConfigDir: c.config,
    cwd: c.cwd,
    sink: c.deferred.sink,
    maxBytes: 128
  }
  expect(await catchUpClaudeTranscript(input)).toMatchObject({ kind: 'capacity' })
  expect(await catchUpClaudeTranscript({ ...input, mode: 'recovery', maxBytes: 4096 })).toBe(true)
  expect(await c.journal.reads.historyOrigin()).toMatchObject({
    raw: {
      kind: 'native_copy',
      ids: ['old-leaf', 'new-question', 'new-answer'],
      sourceFrontier: 'new-answer',
      sourceConsumedBytes: expect.any(Number),
      sourceMtimeMs: expect.any(Number)
    }
  })
  await c.reopen()
  expect(await catchUpClaudeTranscript(input)).toBe(true)
})

it('certifies a recovery the import worker refused, so an unchanged reopen does not retry', async () => {
  const c = await chat('batch')
  await writeFile(
    c.filePath,
    [
      '{"type":"assistant","uuid":"old-leaf","message":{"content":"Old answer"}}',
      ...Array.from({ length: 12 }, (_, index) => `{"type":"progress","uuid":"noise-${index}"}`),
      '{"type":"assistant","uuid":"new-answer","parentUuid":"old-leaf","message":{"content":"New answer"}}',
      ''
    ].join('\n')
  )
  const input = {
    sessionId: SESSION,
    providerSessionId: PROVIDER,
    leafUuid: 'old-leaf',
    claudeConfigDir: c.config,
    cwd: c.cwd,
    sink: c.deferred.sink,
    maxBytes: 128
  }
  expect(await catchUpClaudeTranscript(input)).toMatchObject({ kind: 'capacity' })
  const entry = claudeImportWorkerEntry()
  setClaudeImportWorkerEntry(`${c.filePath}.missing-worker.js`)
  try {
    await catchUpClaudeTranscript({ ...input, mode: 'recovery', maxBytes: 4096 })
  } finally {
    setClaudeImportWorkerEntry(entry)
  }
  expect(await c.journal.reads.historyOrigin()).toMatchObject({
    raw: { sourceFrontier: 'new-answer', sourceConsumedBytes: (await stat(c.filePath)).size }
  })
  await c.reopen()
  expect(await catchUpClaudeTranscript(input)).toBe(true)
})

it('keeps long answers the chat saved whole instead of the clipped re-import', async () => {
  const c = await chat('batch')
  const whole = 'W'.repeat(40 * 1024)
  const streamed = 'S'.repeat(40 * 1024)
  const row = (uuid: string, parentUuid: string | null, text: string, extra = {}) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      parentUuid,
      sessionId: PROVIDER,
      message: { role: 'assistant', id: `msg-${uuid}`, content: [{ type: 'text', text }] },
      ...extra
    })
  await writeFile(
    c.filePath,
    `${[
      row('old-leaf', null, 'old answer'),
      row('saved', 'old-leaf', whole),
      row('streamed', 'saved', streamed, { apiBlockIndex: 0 }),
      row('changed', 'streamed', 'C'.repeat(40 * 1024)),
      ''
    ].join('\n')}`
  )
  // A turn the chat streamed is saved per block, not under its transcript record's id.
  for (const [uuid, text] of [
    ['saved', whole],
    [claudeSourceBlockId('msg-streamed', 0), streamed],
    ['changed', 'E'.repeat(40 * 1024)]
  ] as const) {
    await c.journal.appendItem(
      { provider: 'claude', sessionId: PROVIDER, uuid },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  }
  const input = {
    sessionId: SESSION,
    providerSessionId: PROVIDER,
    leafUuid: 'old-leaf',
    claudeConfigDir: c.config,
    cwd: c.cwd,
    sink: c.deferred.sink,
    maxBytes: 128
  }
  await catchUpClaudeTranscript(input)
  expect(await catchUpClaudeTranscript({ ...input, mode: 'recovery', maxBytes: 1024 * 1024 })).toBe(
    true
  )
  const text = async (uuid: string) => {
    const item = (await c.items()).find(({ itemId }) => itemId === `claude:${PROVIDER}:${uuid}`)
    return item?.body.kind === 'message' && item.body.blocks[0]?.type === 'text'
      ? item.body.blocks[0].text
      : undefined
  }
  expect(await text('saved')).toBe(whole)
  expect(await text('streamed')).toBe(streamed)
  // Text the chat saved differently from the transcript can't prove it is the same turn's text.
  expect((await text('changed'))?.length).toBeLessThan(20 * 1024)
})

it('keeps every sibling of one assistant message across 20k rows', async () => {
  const c = await chat('batch')
  const rows = Array.from({ length: 20_000 }, (_, index) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `part-${index}`,
      parentUuid: index ? `part-${index - 1}` : null,
      message: { id: 'one-message', content: 'x' }
    })
  )
  await writeFile(c.filePath, `${rows.join('\n')}\n`)
  const imported = await claudeImport.importClaudeTranscript({
    agent: 'claude',
    filePath: c.filePath,
    sessionId: PROVIDER,
    limits: { inlineHeadBytes: 1024 },
    retainedBytes: 64 * 1024 * 1024
  })
  expect(imported.items).toHaveLength(20_000)
})

it('bounds one-pass recovery reads while selecting the active item window', async () => {
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
  const imported = await claudeImport.importClaudeTranscript({
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
  const [links] = await Promise.all(read.mock.results.map(({ value }) => value))
  expect(read).toHaveBeenCalledTimes(1)
  // One backward pass reads the whole raw window; payloads come from the spool, not a reread.
  expect([links.bytesRead, links.decodedBytes]).toEqual([rawCap, 44_663])
})

it.each([undefined, true] as const)(
  'bounds bytes read when the transcript exceeds 64 MiB: %s',
  async (bounded) => {
    const c = await chat('batch')
    const padding = `{"type":"progress","data":"${'x'.repeat(1024 * 1024)}"}\n`
    const message = (uuid: string, parentUuid: string | null) =>
      `${JSON.stringify({ type: 'assistant', uuid, parentUuid, message: { content: uuid } })}\n`
    await writeFile(
      c.filePath,
      (async function* () {
        yield message('outside', null)
        for (let index = 0; index < 10; index++) {
          yield padding
        }
        yield message('inside', 'outside')
        for (let index = 0; index < 63; index++) {
          yield padding
        }
        yield message('newest', 'inside')
      })()
    )
    const { size } = await stat(c.filePath)
    sourceStreams.length = 0
    handleReads.bytes = 0
    const window = vi.spyOn(transcriptTail, 'readClaudeTranscriptWindow')
    const imported = await claudeImport.importClaudeTranscript({
      agent: 'claude',
      filePath: c.filePath,
      sessionId: PROVIDER,
      limits: { inlineHeadBytes: 1024 },
      retainedBytes: 2400,
      maxBytes: 128 * 1024 * 1024,
      bounded
    })
    await Promise.all(window.mock.results.map(({ value }) => value))
    // Every source read: streamed lines plus handle reads by the window and any frontier probe.
    const bytesRead =
      sourceStreams.reduce((sum, stream) => sum + stream.bytesRead, 0) + handleReads.bytes
    // The spool keeps payloads, so a first import reads the file once and recovery its window.
    expect(bytesRead).toBe(bounded ? 64 * 1024 * 1024 : size)
    expect(imported.items.map(({ identity }) => identity)).toEqual(
      ['outside', 'inside', 'newest']
        .slice(bounded ? 1 : 0)
        .map((uuid) => ({ provider: 'claude', sessionId: PROVIDER, uuid }))
    )
  }
)

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

it('restores a saved batch over 16 MiB and replaces only the whole newest suffix', async () => {
  const c = await chat('batch')
  const rows: string[] = []
  const whole = 'W'.repeat(600 * 1024)
  for (let i = 0; i < 32; i++) {
    const uuid = `answer-${i}`
    rows.push(
      JSON.stringify({
        type: 'assistant',
        uuid,
        parentUuid: i ? `answer-${i - 1}` : null,
        message: { content: whole }
      })
    )
    await c.journal.appendItem(
      { provider: 'claude', sessionId: PROVIDER, uuid },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: whole }] },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  }
  await writeFile(c.filePath, `${rows.join('\n')}\n`)
  const plan = await prepareCapacityRecovery(c)
  expect(plan).toHaveProperty('kind', 'replace')
  if (!('operation' in plan)) {
    return
  }
  const { items, providerHandle, historyOrigin } = plan.operation
  expect(items).toHaveLength(28)
  expect(items.slice(0, -1).map(({ identity }) => identity)).toEqual(
    Array.from({ length: 27 }, (_, i) => ({
      provider: 'claude',
      sessionId: PROVIDER,
      uuid: `answer-${i + 5}`
    }))
  )
  for (const { body } of items.slice(0, -1)) {
    expect(body).toEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: whole }]
    })
  }
  expect(items.at(-1)?.body).toMatchObject({ presentation: 'continued-outside-recent' })
  expect(Buffer.byteLength(JSON.stringify(items))).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(providerHandle).toMatchObject({ leafUuid: 'answer-31' })
  expect(historyOrigin).toMatchObject({
    ids: Array.from({ length: 27 }, (_, i) => `answer-${i + 5}`),
    sourceFrontier: 'answer-31',
    sourceConsumedBytes: (await stat(c.filePath)).size
  })
})

it('restores whole standalone and embedded tool inputs within their saved call', async () => {
  const c = await chat('batch')
  const toolInput = { path: 'file.txt', content: '\\"é'.repeat(16_000) }
  const call = (id: string) => ({ type: 'tool_use', id, name: 'Write', input: toolInput })
  const source = [
    { uuid: 'standalone', parentUuid: null, content: [call('single-call')] },
    {
      uuid: 'mixed',
      parentUuid: 'standalone',
      content: [{ type: 'text', text: 'Writing the file' }, call('mixed-call'), call('other-call')]
    }
  ]
  const rows = source.map(({ uuid, parentUuid, content }) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      parentUuid,
      sessionId: PROVIDER,
      message: { role: 'assistant', id: uuid, content }
    })
  )
  await writeFile(c.filePath, `${rows.join('\n')}\n`)
  for (const [uuid, callId] of [
    ['standalone', 'single-call'],
    ['mixed', 'mixed-call']
  ]) {
    await c.journal.appendItem(
      { provider: 'claude', sessionId: PROVIDER, uuid: uuid! },
      { kind: 'tool-call', callId, name: 'Write', input: toolInput, state: 'completed' },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  }
  const plan = await prepareCapacityRecovery(c)
  expect('operation' in plan && plan.operation.items.map(({ body }) => body)).toEqual([
    {
      kind: 'tool-call',
      callId: 'single-call',
      name: 'Write',
      input: toolInput,
      state: 'completed'
    },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Writing the file' },
        { type: 'tool-call', callId: 'mixed-call', name: 'Write', input: toolInput },
        {
          type: 'tool-call',
          callId: 'other-call',
          name: 'Write',
          input: expect.objectContaining({ truncated: true })
        }
      ]
    },
    expect.objectContaining({ presentation: 'continued-outside-recent' })
  ])
})

it('keeps prior history and leaves the source uncertified when a saved row cannot be read alone', async () => {
  const c = await chat('batch')
  const text = 'whole'.repeat(240_000)
  await writeFile(
    c.filePath,
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'new-answer',
      parentUuid: 'old-leaf',
      message: { content: text }
    })}\n`
  )
  await c.journal.appendItem(
    { provider: 'claude', sessionId: PROVIDER, uuid: 'new-answer' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await catchUpClaudeTranscript({
    sessionId: SESSION,
    providerSessionId: PROVIDER,
    leafUuid: 'old-leaf',
    claudeConfigDir: c.config,
    cwd: c.cwd,
    sink: c.deferred.sink,
    mode: 'recovery'
  })
  expect((await c.items()).map(({ body }) => body)).toEqual([
    expect.objectContaining({ kind: 'turn' }),
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'old answer' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    expect.objectContaining({ presentation: 'continued-outside-unloaded' })
  ])
  expect(await c.journal.reads.historyOrigin()).toBeNull()
})

it('keeps the prior epoch if the newest item cannot fit whole', async () => {
  const c = await chat('batch')
  const content = Array.from({ length: 540 }, (_, index) => ({
    type: 'tool_use',
    id: `call-${index}`,
    name: 'Write',
    input: { content: '\\'.repeat(8_300) }
  }))
  await writeFile(
    c.filePath,
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'new-answer',
      parentUuid: 'old-leaf',
      message: { role: 'assistant', content }
    })}\n`
  )
  await catchUpClaudeTranscript({
    sessionId: SESSION,
    providerSessionId: PROVIDER,
    leafUuid: 'old-leaf',
    claudeConfigDir: c.config,
    cwd: c.cwd,
    sink: c.deferred.sink,
    mode: 'recovery'
  })
  expect((await c.items()).map(({ body }) => body)).toEqual([
    expect.objectContaining({ kind: 'turn' }),
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'old answer' }] },
    expect.objectContaining({ presentation: 'continued-outside-unloaded' })
  ])
})

async function prepareCapacityRecovery(c: Awaited<ReturnType<typeof chat>>) {
  const signal = new AbortController().signal
  return await capacityRecovery.prepareClaudeTranscriptCapacityRecovery(
    {
      sessionId: SESSION,
      providerSessionId: PROVIDER,
      leafUuid: 'old-leaf',
      filePath: c.filePath,
      physicalCursor: await c.journal.reads.physicalCursor()
    },
    { history: c.journal, signal, check: () => signal.throwIfAborted(), warn: () => {} }
  )
}

// PR #45200: equal-length saved blocks must not rehash the earlier candidates for each match.
it('hashes 512 equal-length saved blocks once each', async () => {
  const c = await chat('batch')
  const rows: string[] = []
  for (let row = 0; row < 16; row++) {
    const uuid = `blocks-${row}`
    const blocks = Array.from({ length: 32 }, (_, index) => ({
      type: 'text' as const,
      text: String(index).padStart(2, '0') + 'x'.repeat(20 * 1024 - 2)
    }))
    rows.push(
      JSON.stringify({
        type: 'assistant',
        uuid,
        parentUuid: row ? `blocks-${row - 1}` : null,
        message: { role: 'assistant', content: blocks }
      })
    )
    await c.journal.appendItem(
      { provider: 'claude', sessionId: PROVIDER, uuid },
      { kind: 'message', role: 'assistant', blocks },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  }
  await writeFile(c.filePath, `${rows.join('\n')}\n`)
  const digest = vi.spyOn(payloadBounds, 'digestPayload')
  const plan = await prepareCapacityRecovery(c)
  expect('operation' in plan && plan.operation.items).toHaveLength(17)
  expect(digest).toHaveBeenCalledTimes(512)
})
