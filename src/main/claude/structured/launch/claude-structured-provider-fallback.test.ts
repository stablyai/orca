import { followTestSinkSnapshots } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-direct-sink.test-fixture'
import { readTestJournalItems } from '../../../native-chat/agent-session-journal/journal-observation.test-support'
import { openTestAgentSessionDatabase } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { openAgentSessionJournal } from '../../../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from '../claude-structured-session-state'
import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { testEventSinkLogging } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('provider-1', 'leaf-1')
}

let root = ''

function message(
  role: 'assistant' | 'user',
  uuid: string,
  content: unknown[]
): ClaudeStructuredSessionEvent {
  return {
    type: 'message',
    sessionId: 'orca-session',
    message: {
      type: role,
      uuid,
      session_id: 'provider-1',
      message: { role, content }
    }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-provider-fallback-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('Claude provider fallback', () => {
  it('drops suppressed init frames instead of dereferencing a null translation', () => {
    const items: { identity: unknown; body: AgentJournalItemBody }[] = []
    const sink = {
      appendItem: (identity: unknown, body: AgentJournalItemBody) => {
        items.push({ identity, body })
      },
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
    const translator = createClaudeJournalTranslator({ sink })
    const initEvent: ClaudeStructuredSessionEvent = {
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'system',
        subtype: 'init',
        session_id: 'provider-1',
        uuid: 'init-1'
      }
    }

    expect(() => translator.handle(initEvent)).not.toThrow()
    expect(items).toEqual([])
  })

  it('journals the captured model fallback as a notice and continues the same turn', () => {
    const items: AgentJournalItemBody[] = []
    const translator = createClaudeJournalTranslator({
      sink: {
        appendItem: (_identity, body) => {
          items.push(body)
        },
        appendTombstone: vi.fn(),
        publish: vi.fn()
      }
    })
    translator.handle(
      message('assistant', 'fallback-1', [
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }
      ])
    )
    translator.handle(
      message('assistant', 'answer-1', [{ type: 'text', text: 'Continuing the answer.' }])
    )
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'result',
        subtype: 'success',
        session_id: 'provider-1',
        uuid: 'result-1',
        result: 'Continuing the answer.'
      }
    })

    const notices = items.filter((body) => body.kind === 'status')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      text: 'Claude switched models: Claude Opus 5.5 → Claude Opus 4.8.',
      tone: 'notice',
      presentation: 'turn-notice',
      providerFrame: { provider: 'claude', kind: 'message:assistant:content:fallback' }
    })
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Continuing the answer.' }]
      })
    )
    expect(items).toContainEqual(expect.objectContaining({ kind: 'turn', state: 'completed' }))
  })

  it('keeps provider-fallback rows distinct across acquisitions', async () => {
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      database: await openTestAgentSessionDatabase(root),
      now: () => 1_700_000_000_000,
      mintEpoch: () => 'epoch-1'
    })
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    await followTestSinkSnapshots(deferred, journal)
    deferred.bind({
      journal,
      fence: 1,
      publish: vi.fn()
    })

    const first = createClaudeJournalTranslator({ sink: deferred.sink, fallbackIdPrefix: '1' })
    const second = createClaudeJournalTranslator({ sink: deferred.sink, fallbackIdPrefix: '2' })

    first.handle(message('assistant', 'assistant-1', [{ type: 'future_event', message: 'first' }]))
    await deferred.drained()
    second.handle(
      message('assistant', 'assistant-2', [{ type: 'future_event', message: 'second' }])
    )
    await deferred.drained()

    const fallbackRows = (await readTestJournalItems(journal)).filter(
      (item) =>
        item.body.kind === 'status' &&
        item.body.providerFrame?.kind === 'message:assistant:content:future_event'
    )

    expect(fallbackRows).toHaveLength(2)
    expect(fallbackRows.map(statusText)).toEqual(['first', 'second'])
  })

  it.each([false, true])(
    'keeps unknown quota result disclosure only for a stopped turn (stopped: %s)',
    async (stopped) => {
      const journal = await openAgentSessionJournal({
        identity: IDENTITY,
        database: await openTestAgentSessionDatabase(root),
        now: () => 1_000
      })
      const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
      await followTestSinkSnapshots(deferred, journal)
      deferred.bind({ journal, fence: 1, publish: () => {} })
      const translator = createClaudeJournalTranslator({ sink: deferred.sink })
      const quota = message('assistant', 'quota', [{ type: 'text', text: 'Usage exhausted' }])
      if (quota.type !== 'message') {
        throw new Error('expected provider message')
      }
      translator.handle({
        ...quota,
        observedAt: 100,
        message: { ...quota.message, api_error: 'usage_limit_reached' }
      })
      await deferred.drained()
      if (stopped) {
        await journal.appendStopEvent({ reason: 'user-stop', turnId: 'quota' }, 1)
      }
      translator.handle({
        type: 'message',
        sessionId: 'orca-session',
        observedAt: 2_000,
        message: {
          type: 'result',
          subtype: 'future_error',
          is_error: true,
          session_id: 'provider-1',
          uuid: 'quota-result',
          result: 'Usage exhausted',
          terminal_reason: 'api_error'
        }
      })
      await deferred.drained()
      const items = await readTestJournalItems(journal)
      const disclosure = items.filter(
        (item) =>
          item.body.kind === 'status' &&
          item.body.providerFrame?.kind === 'message:result:future_error'
      )
      expect(disclosure).toHaveLength(stopped ? 1 : 0)
      if (stopped) {
        expect(disclosure[0]?.body).not.toHaveProperty('tone')
        expect(disclosure[0]?.body).not.toHaveProperty('failure')
      }
      expect(items.find((item) => item.body.kind === 'turn')?.body).toMatchObject({
        kind: 'turn',
        state: stopped ? 'interrupted' : 'completed',
        ...(stopped ? {} : { outcome: 'failure' })
      })
      deferred.close()
      await journal.close()
      const reopened = await openAgentSessionJournal({
        identity: IDENTITY,
        database: await openTestAgentSessionDatabase(root)
      })
      expect(await readTestJournalItems(reopened)).toEqual(items)
      await reopened.close()
    }
  )
})

function statusText(row: { body: AgentJournalItemBody }): string {
  if (row.body.kind !== 'status') {
    throw new Error('expected status row')
  }
  return row.body.text
}
