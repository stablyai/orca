import { claudeProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { beforeEach, expect, it, vi, type Mock } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import { openTestJournalHostDatabase } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  attachParams,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let answerPrompt: Mock<StructuredAgentSessionAdapter['answerPrompt']>
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let serial = 0

beforeEach(() => {
  ;({ root, store, host, answerPrompt, acquire } = hostTestState())
})

function opId(at = NOW): string {
  serial += 1
  return `${at}-${serial.toString(16).padStart(32, 'd')}`
}

function answer(
  prompt: { itemId: string; revision: number },
  clientOperationId: string,
  optionId = 'allow'
) {
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId }
  return {
    envelope: envelope('agentSession.respondTo:approval', fields, { clientOperationId }),
    kind: 'approval' as const,
    ...fields
  }
}

function receipt(id: string, callerKey = CALLER.callerKey) {
  return store.readCommandReceipt({ kind: 'caller', callerKey }, id)
}

function journal() {
  const open = host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('expected an open conversation')
  }
  return open
}

function promptBody(itemId: string): AgentJournalItemBody {
  const body = journal().itemBody(itemId)
  if (!body) {
    throw new Error(`no item ${itemId}`)
  }
  return body
}

it.each(['allow', 'deny'])(
  'commits Claude plan intent with %s and rolls back or replays without overwriting newer picks',
  async (choice) => {
    const originalAcquire = acquire.getMockImplementation()!
    acquire.mockImplementation(async (input) => {
      const result = await originalAcquire(input)
      return { ...result, link: { ...result.link!, handle: claudeProviderHandle(THREAD, null) } }
    })
    expect(
      await host.attach(
        CALLER,
        attachParams({
          provider: 'claude',
          agent: 'claude',
          accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/test-claude' },
          providerHandle: { kind: 'claude', sessionId: THREAD, leafUuid: null }
        })
      )
    ).toMatchObject({ ok: true })
    const before = choice === 'allow' ? 'plan' : 'default'
    const after = choice === 'allow' ? 'default' : 'plan'
    const pick = (interactionMode: string) =>
      store.replaceSessionOptions({
        sessionId: SESSION,
        fence: store.getRecord(SESSION)!.lease.runtimeFence,
        now: NOW,
        options: { model: 'opus[1m]', interactionMode }
      })
    await pick(before)
    const identity = { provider: 'orca' as const, clientMessageId: 'plan-approval' }
    const events = acquire.mock.calls.at(-1)?.[0].events
    if (!events) {
      throw new Error('Expected acquired Claude events')
    }
    events.appendItem(
      identity,
      {
        kind: 'approval',
        title: 'Plan',
        detail: null,
        subject: { kind: 'plan', text: 'Implement this plan' },
        options: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Keep planning' }
        ],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
    const itemId = agentJournalItemKey(identity)
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    const prompt = page.ok ? page.page.items.find((item) => item.itemId === itemId)! : null
    expect(prompt).not.toBeNull()
    const params = answer(prompt!, opId(), choice)
    const db = openTestJournalHostDatabase(root).db
    db.exec(`CREATE TRIGGER fail_plan_record AFTER UPDATE ON agent_session_records
      WHEN json_extract(NEW.record_json, '$.options.interactionMode') = '${after}'
      BEGIN SELECT RAISE(ABORT, 'record unavailable'); END`)
    await expect(host.respondToPrompt(CALLER, params)).rejects.toThrow('record unavailable')
    db.exec('DROP TRIGGER fail_plan_record')
    expect(receipt(params.envelope.clientOperationId)).toEqual({ verdict: 'absent' })
    expect(promptBody(itemId)).toMatchObject({ resolution: { state: 'pending' } })
    expect(store.getRecord(SESSION)?.options).toEqual({
      model: 'opus[1m]',
      interactionMode: before
    })
    expect(await host.respondToPrompt(CALLER, params)).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.options).toEqual({ model: 'opus[1m]', interactionMode: after })
    if (choice === 'deny') {
      const body = hostTestMessage('Continue planning')
      expect(
        await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
      ).toMatchObject({ ok: true })
      await vi.waitFor(() =>
        expect(hostTestState().dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            executionOptions: { model: 'opus[1m]', fastMode: 'false', interactionMode: 'plan' }
          })
        )
      )
    }
    await pick(before)
    expect(await host.respondToPrompt(CALLER, params)).toMatchObject({ ok: true, replayed: true })
    expect(store.getRecord(SESSION)?.options).toEqual({
      model: 'opus[1m]',
      interactionMode: before
    })
    const delivered = answerPrompt.mock.calls.length
    expect(await host.respondToPrompt(CALLER, answer(prompt!, opId(), choice))).toMatchObject({
      ok: true
    })
    expect(answerPrompt).toHaveBeenCalledTimes(delivered)
    expect(store.getRecord(SESSION)?.options).toEqual({
      model: 'opus[1m]',
      interactionMode: before
    })
  }
)
