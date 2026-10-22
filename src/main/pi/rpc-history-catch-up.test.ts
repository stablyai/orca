// Turns made outside a Pi chat, through the path they take: Pi's `get_entries` → walk → staged
// rows → on-disk journal, with the claim the handle would carry between opens.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { catchUpPiSession } from './rpc-history-catch-up'
import { PiHistoryCapture } from './rpc-history-capture'
import { decodePiHistoryClaim, type PiHistoryClaim } from './rpc-history-journal-view'

const SESSION = 'session-pi-catch-up'
const logger = { warn: vi.fn(), error: vi.fn() }

type Entry = { type: 'message'; id: string; parentId: string | null; message: unknown }
function entry(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  text: string
): Entry {
  return { type: 'message', id, parentId, message: { role, content: [{ type: 'text', text }] } }
}

/** Answers `get_entries` the way Pi 1.3.0 does (`rpc-mode.js:503-514`), from what it loaded. */
function piWith(entries: Entry[], leafId = entries.at(-1)?.id ?? null) {
  return {
    request: async (command: string, params: Record<string, unknown> = {}) => {
      expect(command).toBe('get_entries')
      if (params.since === undefined) {
        return { entries, leafId }
      }
      const index = entries.findIndex((candidate) => candidate.id === params.since)
      if (index === -1) {
        throw new JsonlRpcResponseError('get_entries', `Entry not found: ${String(params.since)}`)
      }
      return { entries: entries.slice(index + 1), leafId }
    }
  }
}

const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  logger.warn.mockClear()
})

async function chat() {
  const root = await mkdtemp(join(tmpdir(), 'orca-pi-catch-up-'))
  const file = join(root, 'session.jsonl')
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'pi',
      providerHandle: null
    },
    stateDirectory: root,
    now: () => 1_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => {} })
  cleanups.push(async () => {
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  let claim: PiHistoryClaim | null = null
  let ordinal = 0
  const live = (recordId: string): AgentJournalItemIdentity => ({
    provider: 'legacy',
    agent: 'pi',
    sessionId: SESSION,
    recordId
  })
  const save = async (entries: Entry[]) =>
    writeFile(
      file,
      `${[{ type: 'session', id: 'pi-1' }, ...entries].map((e) => JSON.stringify(e)).join('\n')}\n`
    )
  return {
    /** One open of the chat's Pi, which has just loaded `entries` from its file. */
    open: async (entries: Entry[], leafId?: string) => {
      await save(entries)
      const result = await catchUpPiSession({
        connection: piWith(entries, leafId),
        sessionId: SESSION,
        sessionFile: file,
        lineage: new Set([file]),
        claim,
        sink: deferred.sink,
        signal: new AbortController().signal,
        assertCurrent: () => {},
        logger
      })
      claim = result.claim
      return result
    },
    /** A turn the chat ran: its prompt and answer rows, then the capture its end starts. */
    turn: async (text: string, entries: Entry[], anchor: string | null) => {
      ordinal += 1
      deferred.sink.appendItem(
        { provider: 'orca', clientMessageId: `m${ordinal}` },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      deferred.sink.appendItem(
        live(`run:g:${ordinal}`),
        { kind: 'turn', turnId: `run:g:${ordinal}`, state: 'completed' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      deferred.sink.appendItem(
        live(`message:g:${ordinal}`),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `answer ${text}` }] },
        { turnScope: { kind: 'turn', turnItemId: `legacy/pi/${SESSION}/run:g:${ordinal}` } }
      )
      const persist = vi.fn(async ({ handle }: { handle: { resumeCursor?: string } }) => {
        claim = decodePiHistoryClaim(handle.resumeCursor)
      })
      const capture = new PiHistoryCapture(() => ({
        sessionId: SESSION,
        fence: 1,
        connection: piWith(entries),
        sink: deferred.sink,
        drained: async () => {},
        activity: () => 0,
        handle: () => ({ transport: 'jsonl-rpc', agent: 'pi', nativeId: file }),
        persist,
        logger
      }))
      capture.start({ entry: anchor })
      capture.turnEnded()
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    },
    /** A prompt handed to the chat's Pi whose turn never reached the journal (Orca died). */
    crashedPrompt: async (text: string) => {
      ordinal += 1
      deferred.sink.appendItem(
        { provider: 'orca', clientMessageId: `m${ordinal}` },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await deferred.sink.written?.()
    },
    queuedPrompt: async (text: string) => {
      await journal.appendSubmission({
        clientMessageId: 'queued',
        payloadFingerprint: 'queued',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
        fence: 1,
        handoverRecorded: true
      })
    },
    projected: () =>
      projectStructuredAgentSessionMessages(journal.snapshot().items, [], journal.submissions()),
    items: () => journal.snapshot().items,
    texts: () =>
      journal.snapshot().items.flatMap((item) => {
        if (item.body.kind === 'message') {
          const text = item.body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
          return [`${item.body.role}:${text.join('')}`]
        }
        return item.body.kind === 'status' && item.body.presentation
          ? [`(${item.body.presentation})`]
          : []
      })
  }
}

describe('Pi chat catch-up', () => {
  it('adds terminal turns once, in Pi order, under one divider, and places a rewind', async () => {
    const c = await chat()
    expect(await c.open([])).toEqual({ claim: null, current: true })
    const own = [entry('u1', null, 'user', 'ask 1'), entry('a1', 'u1', 'assistant', 'answer ask 1')]
    await c.turn('ask 1', own, null)

    const fullAnswer = `${'long answer '.repeat(2000)}TAIL`
    const outside = [
      ...own,
      entry('u2', 'a1', 'user', 'ask 2'),
      entry('a2', 'u2', 'assistant', fullAnswer),
      entry('u3', 'a2', 'user', 'ask 3'),
      entry('a3', 'u3', 'assistant', 'answer 3')
    ]
    await c.open(outside)
    const caughtUp = [
      'user:ask 1',
      'assistant:answer ask 1',
      '(continued-outside)',
      'user:ask 2',
      `assistant:${fullAnswer}`,
      'user:ask 3',
      'assistant:answer 3'
    ]
    expect(c.texts()).toEqual(caughtUp)

    // Reopening adds nothing.
    await c.open(outside)
    expect(c.texts()).toEqual(caughtUp)

    // The terminal went back to ask 1's answer and continued from there.
    const rewound = [
      ...outside,
      entry('u4', 'a1', 'user', 'ask 4'),
      entry('a4', 'u4', 'assistant', 'answer 4')
    ]
    await c.open(rewound)
    const afterRewind = [
      ...caughtUp,
      '(continued-outside-rewound)',
      'user:ask 4',
      'assistant:answer 4'
    ]
    expect(c.texts()).toEqual(afterRewind)

    // Re-editing the first prompt starts a new root in the same session tree.
    const rootRewind = [
      ...rewound,
      entry('u5', null, 'user', 'ask 5'),
      entry('a5', 'u5', 'assistant', 'answer 5')
    ]
    expect(await c.open(rootRewind)).toMatchObject({ claim: { entry: 'a5' }, current: true })
    const afterRootRewind = [
      ...afterRewind,
      '(continued-outside-rewound)',
      'user:ask 5',
      'assistant:answer 5'
    ]
    expect(c.texts()).toEqual(afterRootRewind)
    await c.open(rootRewind)
    expect(c.texts()).toEqual(afterRootRewind)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('keeps an image-only terminal prompt and its reply across repeated opens', async () => {
    const c = await chat()
    await c.open([])
    const own = [entry('u1', null, 'user', 'ask 1'), entry('a1', 'u1', 'assistant', 'answer ask 1')]
    await c.turn('ask 1', own, null)
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII='
    const outside = [
      ...own,
      {
        ...entry('u2', 'a1', 'user', ''),
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'image', data, mimeType: 'image/png' }
          ]
        }
      },
      entry('a2', 'u2', 'assistant', 'A tiny image')
    ]
    expect(await c.open(outside)).toMatchObject({ claim: { entry: 'a2' }, current: true })
    const imported = c.items()
    expect(imported.slice(-3).map((item) => item.body)).toEqual([
      expect.objectContaining({ kind: 'status', presentation: 'continued-outside' }),
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', url: `data:image/png;base64,${data}` }]
      },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'A tiny image' }] }
    ])
    await c.open(outside)
    expect(c.items()).toEqual(imported)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('imports outside work above the queued prompt that starts a resting Pi', async () => {
    const c = await chat()
    await c.open([])
    const own = [entry('u1', null, 'user', 'ask 1'), entry('a1', 'u1', 'assistant', 'answer ask 1')]
    await c.turn('ask 1', own, null)
    await c.queuedPrompt('ask next')
    const outside = [
      ...own,
      entry('u2', 'a1', 'user', 'outside'),
      entry('a2', 'u2', 'assistant', 'outside answer')
    ]
    expect(await c.open(outside)).toMatchObject({ claim: { entry: 'a2' }, current: true })
    const projected = c.projected()
    expect(
      projected
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) =>
          message.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
        )
    ).toEqual(['ask 1', 'answer ask 1', 'outside', 'outside answer', 'ask next'])
    await c.open(outside)
    expect(c.projected()).toEqual(projected)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('skips a suffix it cannot split after a crash, then shows later terminal turns', async () => {
    const c = await chat()
    await c.open([])
    const own = [entry('u1', null, 'user', 'ask 1'), entry('a1', 'u1', 'assistant', 'answer ask 1')]
    await c.turn('ask 1', own, null)

    // The chat's Pi saved ask 2 before Orca died; then a terminal wrote ask 3.
    await c.crashedPrompt('ask 2')
    const mixed = [
      ...own,
      entry('u2', 'a1', 'user', 'ask 2'),
      entry('u3', 'u2', 'user', 'ask 3'),
      entry('a3', 'u3', 'assistant', 'answer 3')
    ]
    await c.open(mixed)
    expect(c.texts()).toEqual(['user:ask 1', 'assistant:answer ask 1', 'user:ask 2'])

    // The skip is saved: the next terminal turn shows, nothing before it does.
    await c.open([
      ...mixed,
      entry('u4', 'a3', 'user', 'ask 4'),
      entry('a4', 'u4', 'assistant', 'answer 4')
    ])
    expect(c.texts()).toEqual([
      'user:ask 1',
      'assistant:answer ask 1',
      'user:ask 2',
      '(continued-outside)',
      'user:ask 4',
      'assistant:answer 4'
    ])
  })
})
