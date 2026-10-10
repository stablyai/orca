import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { describe, expect, it } from 'vitest'
import { isAdmissibleAgentJournalItemBody } from '../../shared/agent-session-journal-schemas'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../shared/native-chat-subagent-summary'
import { isSubagentGroupBlock, type NativeChatSubagentEntry } from '../../shared/native-chat-types'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { withJournalQueueMembers } from '../native-chat/agent-session-wire/structured-agent-session-journal-double-test-support'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import {
  CodexSubagentRoster,
  codexSubagentGroupIdentity,
  codexSubagentGroupId
} from './codex-subagent-roster'
import type { CodexThreadItem } from './codex-structured-item-translation'
import {
  MAX_CODEX_SUBAGENT_GROUPS,
  MAX_CODEX_SUBAGENTS_PER_GROUP,
  MAX_CODEX_TOKEN_USAGE_THREADS
} from './codex-structured-journal-limits'

const THREAD = 'thread-parent'
const TURN = 'turn-1'

type Appended = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

function createHarness(options: { threadId?: string | null } = {}): {
  roster: CodexSubagentRoster
  appended: Appended[]
  agents: () => NativeChatSubagentEntry[]
  latest: () => Appended | undefined
} {
  const appended: Appended[] = []
  let clock = 1_000
  const sink: StructuredAgentSessionEventSink = {
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {},
    tryAppendItem: (identity, body) => {
      appended.push({ identity, body })
      return { accepted: true }
    },
    tryPublish: () => ({ accepted: true })
  }
  const roster = new CodexSubagentRoster({
    turnScopeFor: () => AGENT_JOURNAL_THREAD_SCOPE,
    sink,
    primaryThreadId: () => (options.threadId === undefined ? THREAD : options.threadId),
    activeTurn: () => TURN,
    now: () => (clock += 1)
  })
  const agents = (): NativeChatSubagentEntry[] => {
    const body = appended.at(-1)?.body
    if (!body || body.kind !== 'message') {
      return []
    }
    const block = body.blocks.find(isSubagentGroupBlock)
    return block ? block.agents : []
  }
  return { roster, appended, agents, latest: () => appended.at(-1) }
}

function latestIdentity(appended: Appended[]): AgentJournalItemIdentity | undefined {
  return appended.at(-1)?.identity
}

function activity(input: {
  id?: string
  kind: string
  agentThreadId: string
  agentPath: string | null
}): CodexThreadItem {
  return {
    type: 'subAgentActivity',
    id: input.id ?? `item-${input.agentThreadId}-${input.kind}`,
    kind: input.kind,
    agentThreadId: input.agentThreadId,
    agentPath: input.agentPath
  }
}

function deliver(
  roster: CodexSubagentRoster,
  item: CodexThreadItem,
  turnId: string | null = TURN
): void {
  // The fixture includes the child's owner event separately from its activity metadata.
  const state =
    item.kind === 'started'
      ? 'working'
      : item.kind === 'completed'
        ? 'completed'
        : item.kind === 'interrupted'
          ? 'stopped'
          : null
  if (state && typeof item.agentThreadId === 'string') {
    roster.handleTurn({
      threadId: item.agentThreadId,
      turnId: `execution:${item.agentThreadId}`,
      state
    })
  }
  // Every activity item reaches the wire twice: item/started, then item/completed.
  roster.handleItem({ threadId: THREAD, turnId, item })
  roster.handleItem({ threadId: THREAD, turnId, item })
}

/** The real event sink, unbound until `drain`, over a journal double that records appends. */
function createQueuedHarness(): {
  roster: CodexSubagentRoster
  appended: Appended[]
  drain: () => void
} {
  const appended: Appended[] = []
  let clock = 1_000
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const journal = withJournalQueueMembers({
    appendItem: async (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
      appended.push({ identity, body })
      return { cursor: { epoch: 'e', sequence: appended.length } }
    }
  })
  const roster = new CodexSubagentRoster({
    turnScopeFor: () => AGENT_JOURNAL_THREAD_SCOPE,
    sink: deferred.sink,
    primaryThreadId: () => THREAD,
    activeTurn: () => TURN,
    now: () => (clock += 1)
  })
  return {
    roster,
    appended,
    drain: () =>
      deferred.bind({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the roster's rows reach only appendItem and the in-order members the helper adds.
        journal: journal as unknown as StructuredAgentSessionEventTarget['journal'],
        fence: 1,
        publish: () => {}
      })
  }
}

describe('CodexSubagentRoster', () => {
  it('lands the roster append its own publish was buffered beside', () => {
    const { roster, appended, drain } = createQueuedHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    drain()

    // A publish once shared the append's coalescing key and spliced it out of the queue, and
    // `lastSerialized` then suppressed every retry.
    expect(appended).toHaveLength(1)
  })

  it('counts a /morpheus agent as a child — only /root is the turn itself', () => {
    const { roster, agents } = createHarness()

    deliver(roster, activity({ kind: 'started', agentThreadId: 'child-m', agentPath: '/morpheus' }))

    expect(agents()).toMatchObject([{ id: 'child-m', label: 'morpheus', state: 'working' }])
  })

  // `codexSubagentPathSegments` already defines what a path means for the label,
  // and the root check has to agree with it: a path that normalizes to the same
  // node must classify the same way, or one string is both the turn itself and a
  // child of it — a phantom row labelled `root` inflating the group by one.
  it('reads a root path with a trailing or doubled separator as the turn itself', () => {
    for (const agentPath of ['/root/', '/root//', '//root']) {
      const { roster, appended } = createHarness()

      deliver(roster, activity({ kind: 'started', agentThreadId: THREAD, agentPath }))

      expect(appended).toEqual([])
    }
  })

  it('keeps a doubled separator inside a child path off the label', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root//read/' })
    )

    expect(agents()).toMatchObject([{ id: 'child-1', label: 'read' }])
  })

  // An all-whitespace trailing segment survives the empty-segment filter and
  // would draw a row with no visible name at all.
  it('falls back to the placeholder when the trailing segment has nothing to show', () => {
    const { roster, agents } = createHarness()

    deliver(roster, activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/   ' }))

    expect(agents()).toMatchObject([{ id: 'child-1', label: 'subagent' }])
  })

  // The collision ordinal keys on the label, so two segments that render
  // identically must collide rather than both draw as `read`.
  it('collides labels that differ only in surrounding whitespace', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-2', agentPath: '/root/ read ' })
    )

    expect(agents().map((agent) => agent.label)).toEqual(['read', 'read 2'])
  })

  it('ignores the root node so a turn is not its own subagent', () => {
    const { roster, appended } = createHarness()

    deliver(roster, activity({ kind: 'started', agentThreadId: THREAD, agentPath: '/root' }))

    expect(appended).toEqual([])
  })

  it('writes an admissible journal body carrying a plain-text fallback block', () => {
    const { roster, latest } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/list_directory' })
    )

    const body = latest()?.body
    expect(body?.kind).toBe('message')
    expect(isAdmissibleAgentJournalItemBody(body)).toBe(true)
    expect(body?.kind === 'message' ? body.blocks.map((block) => block.type) : []).toEqual([
      'text',
      'subagent-group'
    ])
    expect(
      body?.kind === 'message' && body.blocks[0]?.type === 'text' ? body.blocks[0].text : ''
    ).toBe('Kicked off 1 subagent')
  })

  it('keys the durable identity by the parent turn so a revision lands on one row', () => {
    const { roster, appended } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    deliver(
      roster,
      activity({ kind: 'completed', agentThreadId: 'child-1', agentPath: '/root/read' })
    )

    const expected = codexSubagentGroupIdentity(codexSubagentGroupId(THREAD, TURN))
    expect(new Set(appended.map((entry) => JSON.stringify(entry.identity)))).toEqual(
      new Set([JSON.stringify(expected)])
    )
  })

  it('rule 1 — a duplicate delivery writes no second revision', () => {
    const { roster, appended } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )

    expect(appended).toHaveLength(1)
  })

  it('registers a child after its owner already reported completion', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'completed', agentThreadId: 'child-late', agentPath: '/root/search' })
    )

    expect(agents()).toMatchObject([{ id: 'child-late', label: 'search', state: 'completed' }])
  })

  it('rule 3 — a terminal state latches against a late or duplicate start', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'completed', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    deliver(
      roster,
      activity({ kind: 'interacted', agentThreadId: 'child-1', agentPath: '/root/read' })
    )

    expect(agents()).toMatchObject([{ state: 'completed' }])
  })

  it('rule 4 — the session sweep settles a lost child as unverifiable, not exited', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    deliver(
      roster,
      activity({ kind: 'completed', agentThreadId: 'child-2', agentPath: '/root/search' })
    )
    roster.settleSession()

    expect(agents()).toMatchObject([
      { id: 'child-1', state: 'unverifiable' },
      { id: 'child-2', state: 'completed' }
    ])
  })

  it('lets a swept child still report what it actually did', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    roster.settleSession()
    expect(agents()[0]?.state).toBe('unverifiable')

    // Contact can return — a reconnected provider replays the child's own
    // verdict. Latching the sweep would report a child that finished as one we
    // never saw finish.
    deliver(
      roster,
      activity({ kind: 'completed', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    expect(agents()[0]?.state).toBe('completed')
  })

  it('refuses to put a swept child back to working', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    roster.settleSession()
    // A straggler progress tick after we gave up must not re-light the row.
    deliver(
      roster,
      activity({ kind: 'interacted', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    expect(agents()[0]?.state).toBe('unverifiable')
  })

  it('keeps a real verdict when a later frame disagrees', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'completed', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    deliver(
      roster,
      activity({ kind: 'interrupted', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    expect(agents()[0]?.state).toBe('completed')
  })

  it('rule 4 — the session sweep settles every group and never un-terminals one', () => {
    const { roster, agents, appended } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    roster.settleSession()
    const afterFirstSweep = appended.length
    roster.settleSession()

    expect(agents()).toMatchObject([{ state: 'unverifiable' }])
    expect(appended).toHaveLength(afterFirstSweep)
  })

  it('rule 5 — the whole roster is persisted in the carrier, not just a count', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    roster.handleTokenUsage({ threadId: 'child-1', tokenUsage: { total: { totalTokens: 40661 } } })

    expect(agents()).toMatchObject([
      { id: 'child-1', label: 'read', state: 'working', tokens: 40661 }
    ])
  })

  it('rule 6 — the group id names the parent turn, or says there was none', () => {
    const { roster, appended } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-2', agentPath: '/root/search' }),
      null
    )

    expect(appended.map((entry) => entry.identity)).toEqual([
      { provider: 'orca', clientMessageId: `codex-subagents:${THREAD}:${TURN}` },
      { provider: 'orca', clientMessageId: `codex-subagents:${THREAD}:outside-turn` }
    ])
  })

  it('disambiguates two children that share a trailing path segment', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-2', agentPath: '/root/read' })
    )

    expect(agents().map((agent) => agent.label)).toEqual(['read', 'read 2'])
  })

  it('takes the latest token snapshot per child and never accumulates updates', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    roster.handleTokenUsage({ threadId: 'child-1', tokenUsage: { total: { totalTokens: 100 } } })
    roster.handleTokenUsage({ threadId: 'child-1', tokenUsage: { total: { totalTokens: 250 } } })

    expect(agents()).toMatchObject([{ tokens: 250 }])
  })

  it('retains a usage frame that arrives before the child is known', () => {
    const { roster, agents } = createHarness()

    roster.handleTokenUsage({ threadId: 'child-1', tokenUsage: { total: { totalTokens: 900 } } })
    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )

    expect(agents()).toMatchObject([{ tokens: 900 }])
  })

  it('never attributes the parent thread its own usage', () => {
    const { roster, agents, appended } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    const beforeParentUsage = appended.length
    roster.handleTokenUsage({ threadId: THREAD, tokenUsage: { total: { totalTokens: 26099 } } })

    expect(appended).toHaveLength(beforeParentUsage)
    expect(agents()).toHaveLength(1)
    expect(agents()[0]).not.toHaveProperty('tokens')
  })

  // The row is durable and both readers clip these fields to the same cap, so
  // writing more than that is bytes replayed on every reconnect and then thrown
  // away. The marker is an ellipsis, not the tool-output truncation sentence:
  // `id` is the roster key and the renderer's React key.
  it('bounds the provider strings the roster row carries into the journal', () => {
    const { roster, agents, latest } = createHarness()
    const oversized = 'a'.repeat(20 * 1024)

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: oversized, agentPath: `/root/${oversized}` })
    )

    const entry = agents()[0]
    expect(entry?.label.length).toBeLessThanOrEqual(MAX_SUBAGENT_FIELD_CHARS)
    expect(entry?.label).toMatch(/…~0$/)
    expect(entry?.id.length).toBeLessThanOrEqual(MAX_SUBAGENT_FIELD_CHARS)
    expect(entry?.id).toMatch(/…~0$/)
    expect(JSON.stringify(latest()?.body)).not.toContain('output truncated')
    expect(isAdmissibleAgentJournalItemBody(latest()?.body)).toBe(true)
  })

  // The clip cuts UTF-16 code units, so a boundary landing inside a surrogate
  // pair left a LONE high surrogate in a durable row — malformed, and replaced
  // with U+FFFD through any non-JSON UTF-8 hop.
  it('never clips a provider string mid surrogate pair', () => {
    const { roster, agents } = createHarness()
    const astral = '😀'.repeat(400)

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: astral, agentPath: `/root/${astral}` })
    )

    const entry = agents()[0]
    expect(entry?.id.length).toBeLessThanOrEqual(MAX_SUBAGENT_FIELD_CHARS)
    expect(Buffer.from(entry?.id ?? '', 'utf8').toString('utf8')).toBe(entry?.id)
    expect(Buffer.from(entry?.label ?? '', 'utf8').toString('utf8')).toBe(entry?.label)
  })

  // The clip removes exactly the tail that told two children apart: `id` is the
  // renderer's React key, and `claimLabel` writes its repeat ordinal at the end.
  // Two clipped children collapsing to one key drew two rows under one identity.
  it('keeps clipped ids and labels distinct between children', () => {
    const { roster, agents } = createHarness()
    const prefix = 'p'.repeat(MAX_SUBAGENT_FIELD_CHARS)
    const sharedPath = `/root/${'q'.repeat(640)}`

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: `${prefix}AAAA`, agentPath: sharedPath })
    )
    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: `${prefix}BBBB`, agentPath: sharedPath })
    )

    const entries = agents()
    expect(entries).toHaveLength(2)
    expect(new Set(entries.map((agent) => agent.id)).size).toBe(2)
    expect(new Set(entries.map((agent) => agent.label)).size).toBe(2)
    for (const agent of entries) {
      expect(agent.id.length).toBeLessThanOrEqual(MAX_SUBAGENT_FIELD_CHARS)
      expect(agent.label.length).toBeLessThanOrEqual(MAX_SUBAGENT_FIELD_CHARS)
    }
  })

  it('caps the children one spawn group admits', () => {
    const { roster, agents, appended } = createHarness()
    for (let index = 0; index < MAX_CODEX_SUBAGENTS_PER_GROUP; index++) {
      deliver(
        roster,
        activity({ kind: 'started', agentThreadId: `child-${index}`, agentPath: '/root/read' })
      )
    }
    const atCap = appended.length

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-over-cap', agentPath: '/root/read' })
    )

    expect(agents()).toHaveLength(MAX_CODEX_SUBAGENTS_PER_GROUP)
    expect(agents().map((agent) => agent.id)).not.toContain('child-over-cap')
    // Refusing the child must not burn a revision either.
    expect(appended).toHaveLength(atCap)
  })

  it('retains live spawn groups beyond the settled history budget', () => {
    const { roster, appended, agents } = createHarness()
    for (let index = 0; index <= MAX_CODEX_SUBAGENT_GROUPS; index++) {
      deliver(
        roster,
        activity({ kind: 'started', agentThreadId: `child-${index}`, agentPath: '/root/read' }),
        `turn-${index}`
      )
    }
    const original = codexSubagentGroupIdentity(codexSubagentGroupId(THREAD, 'turn-0'))

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-late', agentPath: '/root/search' }),
      'turn-0'
    )

    expect(latestIdentity(appended)).toEqual(original)
    expect(agents().map((agent) => agent.id)).toEqual(['child-0', 'child-late'])
    expect(roster.retentionSizes().groups).toBe(MAX_CODEX_SUBAGENT_GROUPS + 1)
  })

  it('keeps a token count a later thread-map eviction would otherwise retract', () => {
    const { roster, agents } = createHarness()
    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    roster.handleTokenUsage({ threadId: 'child-1', tokenUsage: { total: { totalTokens: 4242 } } })
    expect(agents()).toMatchObject([{ tokens: 4242 }])

    for (let index = 0; index < MAX_CODEX_TOKEN_USAGE_THREADS; index++) {
      roster.handleTokenUsage({
        threadId: `other-${index}`,
        tokenUsage: { total: { totalTokens: index } }
      })
    }
    deliver(
      roster,
      activity({ kind: 'completed', agentThreadId: 'child-1', agentPath: '/root/read' })
    )

    expect(agents()).toMatchObject([{ state: 'completed', tokens: 4242 }])
  })

  it('caps retained usage threads, so a frame evicted before its child is dropped', () => {
    const { roster, agents } = createHarness()
    roster.handleTokenUsage({ threadId: 'child-1', tokenUsage: { total: { totalTokens: 900 } } })
    for (let index = 0; index < MAX_CODEX_TOKEN_USAGE_THREADS; index++) {
      roster.handleTokenUsage({
        threadId: `other-${index}`,
        tokenUsage: { total: { totalTokens: index } }
      })
    }

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )

    expect(agents()[0]).not.toHaveProperty('tokens')
  })

  it('declines a payload that is not a subagent item or a usage frame', () => {
    const { roster } = createHarness()

    expect(
      roster.handleItem({
        threadId: THREAD,
        turnId: TURN,
        item: { type: 'commandExecution', id: 'item-9' }
      })
    ).toBeNull()
    expect(roster.handleTokenUsage({ threadId: 'child-1' })).toBeNull()
  })

  // A refusal must never advance the duplicate-suppression state: an identical
  // replay would short-circuit and the revision would never be retried. The
  // append and the publish are the two ways to be refused, so both are covered.
  it.each([{ refuse: 'append' as const }, { refuse: 'publish' as const }])(
    'retries the same revision after the $refuse is refused',
    ({ refuse }) => {
      let refusing = true
      const appended: Appended[] = []
      const published: number[] = []
      const refusal = { accepted: false, reason: 'backpressure' } as const
      const roster = new CodexSubagentRoster({
        turnScopeFor: () => AGENT_JOURNAL_THREAD_SCOPE,
        sink: {
          appendItem: () => {},
          appendTombstone: () => {},
          publish: () => {},
          tryAppendItem: (identity, body) => {
            if (refusing && refuse === 'append') {
              return refusal
            }
            appended.push({ identity, body })
            return { accepted: true }
          },
          tryPublish: () => {
            if (refusing && refuse === 'publish') {
              return refusal
            }
            published.push(1)
            return { accepted: true }
          }
        },
        primaryThreadId: () => THREAD,
        activeTurn: () => TURN,
        now: () => 1_000
      })
      const item = activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
      roster.handleTurn({ threadId: 'child-1', turnId: 'child-turn', state: 'working' })

      expect(roster.handleItem({ threadId: THREAD, turnId: TURN, item })).toEqual(refusal)

      // The wire redelivers the very same item; nothing about the roster changed,
      // so only a cleared suppression state can get the revision out.
      refusing = false
      expect(roster.handleItem({ threadId: THREAD, turnId: TURN, item })).toEqual({
        accepted: true
      })
      // The retry re-appends when the publish was the half that failed; the real
      // sink writes both, as revisions of the one group row. What must not happen
      // is the revision never being published at all.
      expect(published).toHaveLength(1)
      const body = appended.at(-1)?.body
      expect(
        body?.kind === 'message' ? body.blocks.filter(isSubagentGroupBlock) : []
      ).toMatchObject([{ agents: [{ id: 'child-1', state: 'working' }] }])
    }
  )

  // The sweep is the last event a group ever gets. A refusal there, left
  // unretried, strands the settled roster's final revision — the exact "row
  // stays stale forever" this row exists to prevent.
  it('republishes the settled roster when the sweep publish was refused', () => {
    let refusing = false
    const appended: Appended[] = []
    const published: number[] = []
    const roster = new CodexSubagentRoster({
      turnScopeFor: () => AGENT_JOURNAL_THREAD_SCOPE,
      sink: {
        appendItem: () => {},
        appendTombstone: () => {},
        publish: () => {},
        tryAppendItem: (identity, body) => {
          appended.push({ identity, body })
          return { accepted: true }
        },
        tryPublish: () => {
          if (refusing) {
            return { accepted: false, reason: 'backpressure' }
          }
          published.push(1)
          return { accepted: true }
        }
      },
      primaryThreadId: () => THREAD,
      activeTurn: () => TURN,
      now: () => 1_000
    })
    roster.handleTurn({ threadId: 'child-1', turnId: 'child-turn', state: 'working' })
    roster.handleItem({
      threadId: THREAD,
      turnId: TURN,
      item: activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    })
    const publishedBeforeSweep = published.length

    refusing = true
    expect(roster.settleSession()).toEqual({ accepted: false, reason: 'backpressure' })

    // The retry sweep flips no state — every child already latched — so only a
    // cleared suppression state can carry the unverifiable roster out.
    refusing = false
    expect(roster.settleSession()).toEqual({ accepted: true })
    expect(published.length).toBe(publishedBeforeSweep + 1)
    const body = appended.at(-1)?.body
    expect(body?.kind === 'message' ? body.blocks.filter(isSubagentGroupBlock) : []).toMatchObject([
      { agents: [{ id: 'child-1', state: 'unverifiable' }] }
    ])
  })

  it('propagates sink backpressure instead of reporting the row as written', () => {
    const roster = new CodexSubagentRoster({
      turnScopeFor: () => AGENT_JOURNAL_THREAD_SCOPE,
      sink: {
        appendItem: () => {},
        appendTombstone: () => {},
        publish: () => {},
        tryAppendItem: () => ({ accepted: false, reason: 'backpressure' }),
        tryPublish: () => ({ accepted: true })
      },
      primaryThreadId: () => THREAD,
      activeTurn: () => TURN
    })

    roster.handleTurn({ threadId: 'child-1', turnId: 'child-turn', state: 'working' })
    expect(
      roster.handleItem({
        threadId: THREAD,
        turnId: TURN,
        item: activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
      })
    ).toEqual({ accepted: false, reason: 'backpressure' })
  })
})
