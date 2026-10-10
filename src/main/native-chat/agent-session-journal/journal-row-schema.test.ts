import { describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION
} from '../../../shared/agent-session-journal-types'
import {
  MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS,
  parseJournalRow,
  type JournalRow
} from './journal-row-schema'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  buildJournalItemRow,
  journalLifecycleBatchRowBuilder,
  type JournalLifecycleMutationInput
} from './journal-row-builders'

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

describe('producer linkage on the persisted row', () => {
  const identity = { provider: 'claude' as const, sessionId: 'claude-session', uuid: 'u-1' }
  const body = { kind: 'status' as const, text: 'child work' }
  const linkage = {
    agentId: 'task-1',
    parentAgentId: 'task-parent',
    providerParentRef: 'toolu_1',
    producerKind: 'agent' as const,
    attempt: 2
  }
  const resolution = {
    state: 'pending',
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }

  /** The full durable path: build the row the appender would write, serialize it
   *  the way the journal file does, and read it back. */
  function roundTrip(withLinkage: boolean): JournalRow | null {
    const state = createJournalReducerState('session-1', 'epoch-1')
    const row = buildJournalItemRow({
      state,
      identity,
      body,
      seq: 1,
      fence: 1,
      ts: 1_700_000_000_000,
      ...(withLinkage ? { linkage } : {}),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const parsed = parseJournalRow(JSON.stringify(row))
    return parsed.ok ? parsed.row : null
  }

  it('writes and reads the bundle back without bumping the schema version', () => {
    const row = roundTrip(true)
    expect(row).toMatchObject(linkage)
    // Deliberately NOT a version bump: an unknown `v` is unreadable and costs an older
    // host the chat, while an unknown KEY is simply ignored by an older host.
    expect(row?.v).toBe(AGENT_SESSION_JOURNAL_SCHEMA_VERSION)
  })

  /** A row this host did not write: a remote peer's, or a corrupted line.
   *  Narrowed to the item arm it always builds, so a caller can read `body`
   *  without re-discriminating a union of six. */
  function parseForeign(
    overrides: Record<string, unknown>
  ): Extract<JournalRow, { kind: 'item' }> | null {
    const parsed = parseJournalRow(
      JSON.stringify({
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-1',
        seq: 7,
        fence: 1,
        ts: 1_700_000_000_000,
        kind: 'item',
        itemId: 'claude:claude-session:u-1',
        revision: 0,
        body,
        ...overrides
      })
    )
    return parsed.ok && parsed.row.kind === 'item' ? parsed.row : null
  }

  it('keeps the row but drops an empty agentId, which would read as a subagent', () => {
    // Presence, not truthiness: `''` left in place hides the row from its own
    // author on every parent-scoped surface, permanently and with no backfill.
    const row = parseForeign({ agentId: '' })
    expect(row).not.toBeNull()
    expect(row && 'agentId' in row).toBe(false)
  })

  it('keeps the row but drops a wrong-typed linkage field', () => {
    const row = parseForeign({ agentId: 42, attempt: 'two', producerKind: '' })
    expect(row).not.toBeNull()
    expect(row && 'agentId' in row).toBe(false)
    expect(row && 'attempt' in row).toBe(false)
    expect(row && 'producerKind' in row).toBe(false)
  })

  it('never lets a bad linkage field reject the row itself', () => {
    // A row validator that REJECTS is a whole-store kill switch: the row leaves
    // the timeline entirely. The content must survive its own bad metadata.
    const row = parseForeign({ agentId: '', parentAgentId: null, providerParentRef: 7 })
    expect(row?.body).toEqual(body)
    expect(row?.seq).toBe(7)
  })

  it('leaves a well-formed foreign linkage bundle untouched', () => {
    // The positive control: the sanitizer must not be dropping everything.
    expect(parseForeign({ agentId: 'task-9', attempt: 3 })).toMatchObject({
      agentId: 'task-9',
      attempt: 3
    })
  })

  it('round-trips a batch mutation that names its own producer, with no version bump', () => {
    const state = createJournalReducerState('session-1', 'epoch-1')
    const own = {
      kind: 'item' as const,
      identity: { ...identity, uuid: 'u-own' },
      body,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
    const build = (child: JournalLifecycleMutationInput) =>
      journalLifecycleBatchRowBuilder(() => state, 'settle-1', [child, own], { fence: 1 })(1, 1)
    const row = build({
      kind: 'item',
      identity,
      body,
      linkage,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })

    const parsed = parseJournalRow(JSON.stringify(row))
    const mutations = parsed.ok && parsed.row.kind === 'lifecycle-batch' ? parsed.row.mutations : []
    expect(mutations[0]).toMatchObject(linkage)
    expect(mutations[1] && 'agentId' in mutations[1]).toBe(false)
    // The same batch without the stamp writes the same version: an older host
    // ignores the unknown keys rather than losing the chat to an unknown `v`.
    expect(row.v).toBe(
      build({ kind: 'item', identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }).v
    )
  })

  it('keeps a batch mutation but drops its unusable producer id', () => {
    // Same policy as the row base: sanitize, never reject — a rejected batch
    // would take every mutation in it out of the timeline.
    const parsed = parseJournalRow(
      JSON.stringify({
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-1',
        seq: 7,
        fence: 1,
        ts: 1_700_000_000_000,
        kind: 'lifecycle-batch',
        settlementId: 'settle-2',
        mutations: [
          { kind: 'item', itemId: 'i-1', revision: 1, body, agentId: '' },
          { kind: 'item', itemId: 'i-2', revision: 1, body, agentId: 'thread-child' }
        ]
      })
    )
    const mutations = parsed.ok && parsed.row.kind === 'lifecycle-batch' ? parsed.row.mutations : []
    expect(mutations).toHaveLength(2)
    expect(mutations[0] && 'agentId' in mutations[0]).toBe(false)
    expect(mutations[1]).toMatchObject({ agentId: 'thread-child' })
  })

  it("omits every key on a row the session's own agent produced", () => {
    const row = roundTrip(false)
    expect(row && 'agentId' in row).toBe(false)
    expect(row && 'producerKind' in row).toBe(false)
  })

  it('accepts a real pre-linkage journal line, which carries no bundle at all', () => {
    // A literal line rather than a constructed row, so this also pins that no
    // unknown-key rejection crept in.
    const legacy =
      '{"v":3,"epoch":"epoch-1","seq":7,"fence":1,"ts":1700000000000,"kind":"item",' +
      '"itemId":"i-1","revision":1,"body":{"kind":"message","role":"assistant",' +
      '"blocks":[{"type":"text","text":"hello"}]}}'
    const parsed = parseJournalRow(legacy)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && 'agentId' in parsed.row).toBe(false)
  })

  it('parses a prompt shape with linkage on the row', () => {
    const question = {
      ...BASE,
      v: 3,
      kind: 'item',
      itemId: 'i-q',
      revision: 1,
      ...linkage,
      body: {
        kind: 'question',
        question: 'Which lane?',
        options: [{ id: 'o-1', label: 'First' }],
        resolution
      }
    }
    const parsed = parseJournalRow(JSON.stringify(question))
    expect(parsed.ok).toBe(true)
  })

  it('reads the same row with linkage put INSIDE a prompt option, ignoring the key there', () => {
    // Older builds read prompt options strictly and dropped the journal from such a row, which is
    // why the bundle rides the row base and never a body. This build ignores and keeps the key.
    const smuggled = {
      ...BASE,
      v: 3,
      kind: 'item',
      itemId: 'i-q',
      revision: 1,
      body: {
        kind: 'question',
        question: 'Which lane?',
        options: [{ id: 'o-1', label: 'First', agentId: 'task-1' }],
        resolution
      }
    }
    const parsed = parseJournalRow(JSON.stringify(smuggled))
    expect(parsed.ok && parsed.row.kind === 'item' && parsed.row.body).toEqual(smuggled.body)
    expect(parsed.ok && 'agentId' in parsed.row).toBe(false)
  })
})

describe('journal revision admission', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1e100])(
    'uses the same integer rule for revision %s in rows and nested mutations',
    (revision) => {
      for (const kind of ['item', 'tombstone'] as const) {
        const mutation = {
          kind,
          itemId: 'old',
          revision,
          ...(kind === 'item' ? { body: { kind: 'status', text: 'x' } } : {})
        }
        expect(parseJournalRow(JSON.stringify({ ...BASE, ...mutation })).ok).toBe(
          Number.isInteger(revision)
        )
        expect(
          parseJournalRow(
            JSON.stringify({
              ...BASE,
              kind: 'lifecycle-batch',
              settlementId: 'end',
              mutations: [mutation]
            })
          ).ok
        ).toBe(Number.isInteger(revision))
      }
    }
  )
})

it('preserves stored keys and reducer aliases across an item revision and a tombstone', () => {
  const state = createJournalReducerState('session-1', 'epoch-1')
  state.aliases.set('provider:opaque%ZZ', 'canonical')
  state.tombstones.set('canonical', 7)
  const row = buildJournalItemRow({
    state,
    itemId: 'provider:opaque%ZZ',
    body: { kind: 'status', text: 'ended' },
    seq: 1,
    fence: 1,
    ts: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  expect(row).toMatchObject({ itemId: 'provider:opaque%ZZ', revision: 8 })
  expect(parseJournalRow(JSON.stringify(row)).ok).toBe(true)
  applyJournalRow(state, row)
  expect([...state.items.keys()]).toEqual(['canonical'])
  const removed = journalLifecycleBatchRowBuilder(
    () => state,
    'remove',
    [{ kind: 'tombstone', itemId: 'provider:opaque%ZZ' }],
    { fence: 1 }
  )(2, 1)
  expect(removed.mutations).toEqual([
    { kind: 'tombstone', itemId: 'provider:opaque%ZZ', revision: 9 }
  ])
  expect(parseJournalRow(JSON.stringify(removed)).ok).toBe(true)
  applyJournalRow(state, removed)
  expect(state.items.size).toBe(0)
  expect(state.tombstones.get('canonical')).toBe(9)
})
