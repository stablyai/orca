import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import {
  MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS,
  parseJournalRow,
  type JournalRow
} from './journal-row-schema'
import { createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow } from './journal-row-builders'

const BASE = { v: 1, epoch: 'epoch-1', seq: 1, fence: 1, ts: 1 }

function parse(row: Record<string, unknown>): boolean {
  return parseJournalRow(JSON.stringify(row)).ok
}

describe('journal row validation', () => {
  it('upcasts v1 rows to the current schema without changing their body', () => {
    const parsed = parseJournalRow(
      JSON.stringify({
        ...BASE,
        kind: 'item',
        itemId: 'i-1',
        revision: 1,
        body: { kind: 'status', text: 'from schema v1' }
      })
    )

    expect(parsed).toEqual({
      ok: true,
      row: expect.objectContaining({
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        body: { kind: 'status', text: 'from schema v1' }
      })
    })
  })

  it('treats future-version rows as unreadable before validating future body shapes', () => {
    expect(
      parseJournalRow(
        JSON.stringify({
          ...BASE,
          v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION + 1,
          kind: 'item',
          itemId: 'future',
          revision: 1,
          body: { kind: 'future-render-kind', payload: { anything: true } }
        })
      )
    ).toEqual({ ok: false, unreadable: true })
  })

  it('accepts every fully-formed row shape this build writes', () => {
    expect(
      parse({
        ...BASE,
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { kind: 'codex', threadId: 't' }
      })
    ).toBe(true)
    expect(
      parse({
        ...BASE,
        kind: 'item',
        itemId: 'i-1',
        revision: 1,
        body: { kind: 'status', text: 'x' }
      })
    ).toBe(true)
    expect(parse({ ...BASE, kind: 'tombstone', itemId: 'i-1', revision: 2 })).toBe(true)
    expect(
      parse({
        ...BASE,
        kind: 'submission',
        clientMessageId: 'm-1',
        payloadFingerprint: 'a'.repeat(64),
        providerHandle: { kind: 'codex', threadId: 't' },
        body: { kind: 'message', role: 'user', blocks: [] }
      })
    ).toBe(true)
    expect(
      parse({
        ...BASE,
        kind: 'dispatch',
        clientMessageId: 'm-1',
        state: 'accepted',
        providerItemId: 'codex:t:turn:0',
        reason: null
      })
    ).toBe(true)
  })

  it('rejects a dispatch row missing its state or with mistyped fields', () => {
    expect(parse({ ...BASE, kind: 'dispatch', clientMessageId: 'm-1' })).toBe(false)
    expect(
      parse({
        ...BASE,
        kind: 'dispatch',
        clientMessageId: 'm-1',
        state: 7,
        providerItemId: null,
        reason: null
      })
    ).toBe(false)
    expect(
      parse({
        ...BASE,
        kind: 'dispatch',
        clientMessageId: 'm-1',
        state: 'accepted',
        providerItemId: 7,
        reason: null
      })
    ).toBe(false)
    expect(
      parse({
        ...BASE,
        kind: 'dispatch',
        clientMessageId: 'm-1',
        state: 'rejected',
        providerItemId: null,
        reason: 7
      })
    ).toBe(false)
  })

  it('rejects a submission row without its fingerprint, handle, or message body', () => {
    const submission = {
      ...BASE,
      kind: 'submission',
      clientMessageId: 'm-1',
      payloadFingerprint: 'a'.repeat(64),
      providerHandle: { kind: 'codex', threadId: 't' },
      body: { kind: 'message', role: 'user', blocks: [] }
    }
    expect(parse({ ...submission, payloadFingerprint: undefined as never })).toBe(false)
    expect(parse({ ...submission, providerHandle: 'codex' })).toBe(false)
    expect(parse({ ...submission, body: 'hi' })).toBe(false)
  })

  it('rejects an item row whose body is not a kinded object', () => {
    expect(parse({ ...BASE, kind: 'item', itemId: 'i-1', revision: 1 })).toBe(false)
    expect(parse({ ...BASE, kind: 'item', itemId: 'i-1', revision: 1, body: 'text' })).toBe(false)
    expect(parse({ ...BASE, kind: 'item', itemId: 'i-1', revision: 1, body: {} })).toBe(false)
  })

  it('rejects an epoch row without a provider handle', () => {
    expect(parse({ ...BASE, kind: 'epoch', reason: 'session_created' })).toBe(false)
  })

  it('rejects JSON-valid nested body corruption that would throw during render', () => {
    const item = (body: unknown) => ({ ...BASE, kind: 'item', itemId: 'i-1', revision: 1, body })
    // A resolved question's options are mapped by the projection; null throws there.
    expect(
      parse(
        item({
          kind: 'question',
          question: 'Deploy?',
          options: null,
          resolution: { state: 'resolved', selectedOptionId: 'a', resolvedBy: 'c', resolvedAt: 1 }
        })
      )
    ).toBe(false)
    // Prompt surfaces read `resolution.state` before anything else.
    expect(
      parse(item({ kind: 'question', question: 'Deploy?', options: [], resolution: null }))
    ).toBe(false)
    expect(parse(item({ kind: 'message', role: 'user', blocks: 'not-blocks' }))).toBe(false)
    expect(parse(item({ kind: 'diff', path: 'a.ts', patch: { head: 'x' } }))).toBe(false)
    expect(
      parse(
        item({ kind: 'approval', title: 't', detail: null, options: [{ id: 1 }], resolution: null })
      )
    ).toBe(false)
    // `turnLifecycle.turnId` is read whenever the value is truthy.
    expect(parse(item({ kind: 'status', text: 'x', turnLifecycle: true }))).toBe(false)
  })

  it('rejects a submission row whose body is not a message item', () => {
    expect(
      parse({
        ...BASE,
        kind: 'submission',
        clientMessageId: 'm-1',
        payloadFingerprint: 'a'.repeat(64),
        providerHandle: { kind: 'codex', threadId: 't' },
        body: { kind: 'status', text: 'not a message' }
      })
    ).toBe(false)
  })

  it('keeps forward compatibility for open string fields and unknown block types', () => {
    const item = (body: unknown) => ({ ...BASE, kind: 'item', itemId: 'i-1', revision: 1, body })
    // Renderers select known block types by equality and skip the rest.
    expect(
      parse(item({ kind: 'message', role: 'user', blocks: [{ type: 'future-block', data: 1 }] }))
    ).toBe(true)
    // Role and tool-call state are type-checked, never enum-checked.
    expect(
      parse(item({ kind: 'message', role: 'narrator', blocks: [{ type: 'text', text: 'hi' }] }))
    ).toBe(true)
    expect(parse(item({ kind: 'tool-call', name: 'Read', input: {}, state: 'paused' }))).toBe(true)
    expect(
      parse(
        item({
          kind: 'question',
          question: 'Deploy?',
          options: [{ id: 'a', label: 'Yes' }],
          resolution: {
            state: 'deferred',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          },
          futureField: 'ignored'
        })
      )
    ).toBe(true)
  })

  it('keeps forward compatibility for new dispatch states without a version bump', () => {
    expect(
      parse({
        ...BASE,
        kind: 'dispatch',
        clientMessageId: 'm-1',
        state: 'some-future-state',
        providerItemId: null,
        reason: null
      })
    ).toBe(true)
  })

  it('rejects lifecycle batches beyond the persisted mutation bound', () => {
    const mutation = { kind: 'tombstone', itemId: 'i-1', revision: 1 }
    expect(
      parse({
        ...BASE,
        kind: 'lifecycle-batch',
        settlementId: 'settlement-1',
        mutations: Array.from({ length: MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS + 1 }, () => mutation)
      })
    ).toBe(false)
  })
})

describe('producer attribution on the persisted row', () => {
  const state = createJournalReducerState('session-1', 'epoch-1')
  const identity = { provider: 'claude' as const, sessionId: 'claude-session', uuid: 'u-1' }
  const body = { kind: 'status' as const, text: 'child work' }

  /** The full durable path: build the row the appender would write, serialize it the
   *  way the journal file does, and read it back. */
  function roundTrip(producedBySubagent?: true): JournalRow | null {
    const row = buildJournalItemRow({
      state,
      identity,
      body,
      seq: 1,
      fence: 1,
      ts: 1_700_000_000_000,
      ...(producedBySubagent ? { producedBySubagent } : {})
    })
    const parsed = parseJournalRow(JSON.stringify(row))
    return parsed.ok ? parsed.row : null
  }

  it('writes and reads back the marker without bumping the schema version', () => {
    const row = roundTrip(true)
    expect(row?.producedBySubagent).toBe(true)
    // Deliberately NOT a version bump: an unknown `v` is unreadable and latches the
    // host read-only, while an unknown KEY is simply ignored by an older host.
    expect(row?.v).toBe(AGENT_SESSION_JOURNAL_SCHEMA_VERSION)
  })

  it("omits the key entirely on a row the session's own agent produced", () => {
    const row = roundTrip()
    expect(row && 'producedBySubagent' in row).toBe(false)
  })

  it('accepts a real pre-change journal line, which carries no marker at all', () => {
    // A literal line rather than a constructed row, so this also pins that no
    // unknown-key rejection crept in.
    const legacy =
      '{"v":3,"epoch":"epoch-1","seq":7,"fence":1,"ts":1700000000000,"kind":"item",' +
      '"itemId":"i-1","revision":1,"body":{"kind":"message","role":"assistant",' +
      '"blocks":[{"type":"text","text":"hello"}]}}'
    const parsed = parseJournalRow(legacy)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && 'producedBySubagent' in parsed.row).toBe(false)
  })
})
