import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalToolCallState
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexItemBody } from '../../codex/structured/items/codex-structured-item-translation'
import {
  AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES,
  agentJournalItemForWire
} from '../agent-session-wire/agent-session-item-wire-form'
import { journalPayload } from './journal-payload-bounds'
import { createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow, journalLifecycleBatchRowBuilder } from './journal-row-builders'

afterEach(() => vi.restoreAllMocks())

describe('journal payload allocation bounds', () => {
  it('saves a large Codex command whole and sends a client only its head, encoding only that', () => {
    const payload = 'x'.repeat(50 * 1024 * 1024)
    const body = codexItemBody({
      type: 'commandExecution',
      id: 'command',
      status: 'completed',
      command: 'cat large.log',
      cwd: '/workspace',
      aggregatedOutput: payload,
      exitCode: 0
    })
    if (body?.kind !== 'tool-call') {
      throw new Error('Completed command did not produce a tool-call journal body')
    }
    expect(body.output).toMatchObject({
      head: payload,
      byteLength: payload.length,
      truncated: false
    })

    const from = vi.spyOn(Buffer, 'from')
    const allocUnsafe = vi.spyOn(Buffer, 'allocUnsafe')
    const sent = agentJournalItemForWire({
      itemId: 'command',
      revision: 1,
      body,
      sequence: 1,
      observedAt: 1
    }).item
    const encodedStringBytes = from.mock.calls.reduce(
      (largest, [value]) =>
        typeof value === 'string' ? Math.max(largest, Buffer.byteLength(value, 'utf8')) : largest,
      0
    )
    const largestAllocation = allocUnsafe.mock.calls.reduce(
      (largest, [bytes]) => Math.max(largest, bytes),
      0
    )
    vi.restoreAllMocks()

    expect(sent.shortened).toBe(true)
    expect(sent.body).toMatchObject({
      kind: 'tool-call',
      input: { command: 'cat large.log', cwd: '/workspace' },
      output: {
        head: 'x'.repeat(AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES),
        byteLength: payload.length,
        truncated: true
      }
    })
    expect(encodedStringBytes).toBeLessThanOrEqual(AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES)
    expect(largestAllocation).toBeLessThanOrEqual(AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES)
  })

  it('journals running tool output as a preview and the closing revision whole', () => {
    const output = journalPayload('x'.repeat(64 * 1024))
    const preview = { ...output, head: 'x'.repeat(16 * 1024), truncated: true }
    const call = (state: AgentJournalToolCallState): AgentJournalItemBody => ({
      kind: 'tool-call',
      name: 'shell',
      callId: 'call',
      input: null,
      state,
      output
    })
    const journal = createJournalReducerState('session-1', 'epoch-1')
    const itemRow = (body: AgentJournalItemBody) =>
      buildJournalItemRow({
        state: journal,
        itemId: 'call',
        body,
        seq: 1,
        fence: 1,
        ts: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }).body
    const batchRow = (body: AgentJournalItemBody) =>
      journalLifecycleBatchRowBuilder(
        () => journal,
        'settle',
        [{ kind: 'item', itemId: 'call', body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }],
        { fence: 1 }
      )(1, 1).mutations[0]

    expect(itemRow(call('running'))).toMatchObject({ output: preview })
    expect(batchRow(call('running'))).toMatchObject({ body: { output: preview } })
    expect(itemRow(call('completed'))).toMatchObject({ output })
    expect(batchRow(call('failed'))).toMatchObject({ body: { output } })
  })
})
