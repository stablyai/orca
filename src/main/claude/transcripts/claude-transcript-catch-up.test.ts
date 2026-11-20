import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catchUpClaudeTranscript } from './claude-transcript-catch-up'
import * as legacyImport from '../../native-chat/agent-session-journal/history-import/journal-legacy-import'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { readTestJournalItems } from '../../native-chat/agent-session-journal/journal-observation.test-support'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener
} from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  testEventSinkLogging,
  recordingStructuredAgentSessionLogger
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'

const journals = createTrackedJournalOpener({ legacyInputs: true })
const cleanups: (() => Promise<void>)[] = []
const SESSION = 'chat-catch-up'
const PROVIDER = 'provider-catch-up'

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function chat(mode: 'tail' | 'batch' | 'metadata' = 'tail') {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-catch-up-'))
  const config = join(root, 'claude')
  const project = join(config, 'projects', 'project')
  await mkdir(project, { recursive: true })
  const filePath = join(project, `${PROVIDER}.jsonl`)
  const file = await open(filePath, 'w')
  const row = (uuid: string, parentUuid: string | null, text: string, type = 'assistant') => ({
    type,
    uuid,
    parentUuid,
    sessionId: PROVIDER,
    timestamp: '2026-11-01T00:00:00.000Z',
    message: { role: type, id: uuid, content: [{ type: 'text', text }] }
  })
  try {
    await file.write(`${JSON.stringify(row('old-leaf', null, 'old answer'))}\n`)
    let parent = 'old-leaf'
    if (mode === 'tail') {
      for (let i = 0; i < 27; i++) {
        const boundary = `compact-${i}`
        await file.write(
          `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: boundary, parentUuid: null, logicalParentUuid: parent })}\n`
        )
        parent = `outside-${i}`
        await file.write(`${JSON.stringify(row(parent, boundary, 'x'.repeat(640 * 1024)))}\n`)
      }
    } else if (mode === 'batch') {
      for (let i = 0; i < 600; i++) {
        const prompt = `prompt-${i}`
        await file.write(`${JSON.stringify(row(prompt, parent, 'outside question', 'user'))}\n`)
        parent = `answer-${i}`
        await file.write(`${JSON.stringify(row(parent, prompt, 'outside answer'))}\n`)
      }
    }
    await file.write(
      `${JSON.stringify(row('newest-answer', parent, 'Distinctive newest outside answer'))}\n`
    )
    if (mode === 'metadata') {
      for (let i = 0; i < 27; i++) {
        await file.write(
          `${JSON.stringify({ type: 'progress', uuid: `progress-${i}`, data: 'x'.repeat(640 * 1024) })}\n`
        )
      }
    }
  } finally {
    await file.close()
  }
  const options = {
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle(PROVIDER, 'old-leaf')
    },
    stateDirectory: root
  }
  let journal = await journals.open(options)
  await journal.appendItem(
    { provider: 'claude', sessionId: PROVIDER, uuid: 'old-turn' },
    { kind: 'turn', turnId: 'old-turn', state: 'completed' },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendItem(
    { provider: 'claude', sessionId: PROVIDER, uuid: 'old-leaf' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'old answer' }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.close()
  await closeTestJournalHostDatabase(root)
  journal = await journals.open({ ...options, recover: { fence: 1 } })
  const logging = recordingStructuredAgentSessionLogger()
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(SESSION),
    logger: logging.logger
  })
  const publish = vi.fn()
  deferred.bind({ journal, fence: 1, publish })
  cleanups.push(async () => {
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  return {
    get journal() {
      return journal
    },
    appendOutsideAnswer: async () => {
      const file = await open(filePath, 'a')
      try {
        await file.write(
          `${JSON.stringify(row('later-answer', 'newest-answer', 'Later outside answer'))}\n`
        )
      } finally {
        await file.close()
      }
    },
    logs: logging.entries,
    deferred,
    publish,
    reopen: async () => {
      deferred.unbind()
      await journal.close()
      await closeTestJournalHostDatabase(root)
      journal = await journals.open({ ...options, recover: { fence: 1 } })
      deferred.bind({ journal, fence: 1, publish })
    },
    catchUp: () =>
      catchUpClaudeTranscript({
        sessionId: SESSION,
        providerSessionId: PROVIDER,
        leafUuid: 'old-leaf',
        claudeConfigDir: config,
        cwd: root,
        sink: deferred.sink,
        logger: logging.logger
      }),
    items: () => readTestJournalItems(journal)
  }
}

it.each(['tail', 'batch', 'metadata'] as const)(
  'shows newest outside history and discloses its retained window after exceeding the %s capacity',
  async (mode) => {
    const c = await chat(mode)
    if (mode === 'batch') {
      const prepare = legacyImport.prepareLegacyTranscriptImport
      vi.spyOn(legacyImport, 'prepareLegacyTranscriptImport').mockImplementationOnce(
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

it('drops a replacement when another write at the same fence wins after the captured view', async () => {
  const c = await chat()
  const replace = c.deferred.sink.tryReplaceHistory?.bind(c.deferred.sink)
  if (!replace) {
    throw new Error('missing production history replacement')
  }
  const replaced = vi.fn()
  c.journal.epochReplacements.observe(replaced)
  vi.spyOn(c.deferred.sink, 'tryReplaceHistory').mockImplementationOnce((replacement) => {
    c.deferred.sink.appendItem(
      { provider: 'orca', clientMessageId: 'concurrent' },
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
})

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
    vi.spyOn(legacyImport, 'prepareLegacyTranscriptImport').mockResolvedValue({
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
