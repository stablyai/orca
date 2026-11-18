import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { CODEX_USER_INPUT_METHOD } from '../prompts/codex-prompt-registry'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'
import { journalTarget } from './codex-deferred-sink-target-test-support'
import { readTestJournalItems } from '../../../native-chat/agent-session-journal/journal-observation.test-support'
import { createTrackedJournalOpener } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { testEventSinkLogging } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-translation-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function savedBodies(target: { journal: Parameters<typeof readTestJournalItems>[0] }) {
  return (await readTestJournalItems(target.journal)).map((item) => item.body)
}

type Row = { key: string; body: AgentJournalItemBody }

function recorder() {
  const rows: Row[] = []
  const tombstones: string[] = []
  const bound: [string, string, string][] = []
  let publishes = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: (identity) => tombstones.push(agentJournalItemKey(identity)),
    publish: () => {
      publishes += 1
    }
  }
  return {
    sink,
    rows,
    tombstones,
    bound,
    publishes: () => publishes,
    bindPromptItemId: (journalItemId: string, threadId: string, promptKey: string) =>
      bound.push([journalItemId, threadId, promptKey])
  }
}

function notification(
  method: string,
  params: unknown,
  threadId = THREAD_ID
): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId, method, params }
}

function pausedDeferred() {
  return createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(),
    watermarks: {
      pauseQueuedBytes: 1,
      lowQueuedBytes: 0,
      pauseQueuedOperations: 1,
      lowQueuedOperations: 0
    }
  })
}

describe('codex journal translation', () => {
  it('admits authoritative item completion while the deferred sink pauses reading', async () => {
    const publishes: string[] = []
    const readingControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(),
      watermarks: {
        pauseQueuedBytes: 1,
        lowQueuedBytes: 0,
        pauseQueuedOperations: 1,
        lowQueuedOperations: 0
      },
      readingControl
    })
    const translator = createCodexJournalTranslator({ sink: deferred.sink })

    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'exec-hard-watermark', status: 'inProgress' }
      })
    )
    translator.handle(
      notification('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'exec-hard-watermark',
          command: 'run',
          status: 'completed',
          aggregated_output: 'done'
        }
      })
    )

    expect(deferred.state()).toMatchObject({ backpressured: true })
    expect(readingControl.pauseReading).toHaveBeenCalled()

    const target = await journalTarget(journals, root, publishes)
    deferred.bind(target)
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })

    expect(await savedBodies(target)).toEqual([
      expect.objectContaining({
        kind: 'tool-call',
        state: 'completed',
        output: expect.objectContaining({ head: 'done' })
      })
    ])
    expect(publishes).toHaveLength(1)
    expect(deferred.state()).toMatchObject({ queuedOperations: 0, backpressured: false })
    expect(readingControl.resumeReading).toHaveBeenCalled()

    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'next-message', text: 'next turn still works' }
      })
    )
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })
    expect((await savedBodies(target)).at(-1)).toMatchObject({
      kind: 'message',
      blocks: [{ type: 'text', text: 'next turn still works' }]
    })
  })

  it('admits user-input prompt questions and their publish while the sink pauses reading', async () => {
    const publishes: string[] = []
    const bound: [string, string, string][] = []
    const deferred = pausedDeferred()
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      bindPromptItemId: (journalItemId, threadId, promptKey) =>
        bound.push([journalItemId, threadId, promptKey])
    })

    const admission = translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_USER_INPUT_METHOD,
      params: {
        questions: [
          { id: 'q1', question: 'Which branch?', options: [{ label: 'main' }] },
          { id: 'q2', question: 'Proceed?', options: [{ label: 'yes' }] }
        ]
      },
      codexItemId: 'exec-1',
      promptKey: 'input-hard-watermark'
    })

    expect(admission).toEqual({ accepted: true })
    expect(bound.map(([journalItemId]) => journalItemId)).toEqual([
      'orca:codex-prompt%3Athread-abc%3Ainput-hard-watermark%3Aq1',
      'orca:codex-prompt%3Athread-abc%3Ainput-hard-watermark%3Aq2'
    ])
    expect(deferred.state()).toMatchObject({ backpressured: true })

    const target = await journalTarget(journals, root, publishes)
    deferred.bind(target)
    await expect(deferred.lifecycleBarrier()).resolves.toEqual({ ok: true })

    expect(await savedBodies(target)).toEqual([
      expect.objectContaining({ kind: 'question', question: 'Which branch?' }),
      expect.objectContaining({ kind: 'question', question: 'Proceed?' })
    ])
    expect(publishes).toHaveLength(1)
  })

  it('refuses an untranslated user-input prompt without binding live state', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      bindPromptItemId: tap.bindPromptItemId
    })

    const admission = translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_USER_INPUT_METHOD,
      params: { questions: [{ id: 'q1' }] },
      codexItemId: 'exec-1',
      promptKey: 'untranslated-input'
    })

    expect(admission).toEqual({ accepted: false, reason: 'untranslated' })
    expect(tap.rows).toEqual([])
    expect(tap.bound).toEqual([])
    expect(tap.publishes()).toBe(0)
  })
})
