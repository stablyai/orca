import { describe, expect, it } from 'vitest'
import { isAdmissibleAgentJournalItemBody } from '../../shared/agent-session-journal-schemas'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { isSubagentGroupBlock, type NativeChatSubagentEntry } from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CodexSubagentRoster,
  codexSubagentGroupIdentity,
  codexSubagentGroupId
} from './codex-subagent-roster'
import type { CodexThreadItem } from './codex-structured-item-translation'

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
  // Every activity item reaches the wire twice: item/started, then item/completed.
  roster.handleItem({ threadId: THREAD, turnId, item })
  roster.handleItem({ threadId: THREAD, turnId, item })
}

/**
 * A sink that coalesces the way the real queue does: by `coalescingKey` ALONE,
 * with no op-kind check, and only draining when released. A fake that ignores
 * the key cannot see an append being spliced out by its own publish.
 */
function createCoalescingHarness(): {
  roster: CodexSubagentRoster
  appended: Appended[]
  drain: () => void
} {
  const appended: Appended[] = []
  const queue: { key?: string; run: () => void }[] = []
  let clock = 1_000
  const submit = (key: string | undefined, run: () => void): void => {
    const at = key === undefined ? -1 : queue.findIndex((queued) => queued.key === key)
    if (at >= 0) {
      queue.splice(at, 1)
    }
    queue.push(key === undefined ? { run } : { key, run })
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {},
    tryAppendItem: (identity, body, options) => {
      submit(options?.coalescingKey, () => appended.push({ identity, body }))
      return { accepted: true }
    },
    tryPublish: (options) => {
      submit(options?.coalescingKey ?? 'publish', () => {})
      return { accepted: true }
    }
  }
  const roster = new CodexSubagentRoster({
    sink,
    primaryThreadId: () => THREAD,
    activeTurn: () => TURN,
    now: () => (clock += 1)
  })
  return {
    roster,
    appended,
    drain: () => {
      while (queue.length > 0) {
        queue.shift()?.run()
      }
    }
  }
}

describe('CodexSubagentRoster', () => {
  it('does not let its own publish evict the still-queued roster append', () => {
    const { roster, appended, drain } = createCoalescingHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    drain()

    // Sharing the append's coalescing key with the publish spliced the append
    // out of the queue, and `lastSerialized` then suppressed every retry.
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

  it('rule 2 — a first event of any kind creates the entry in the state it implies', () => {
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

  it('rule 4 — the turn-end sweep settles a lost child as unverifiable, not exited', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    deliver(
      roster,
      activity({ kind: 'completed', agentThreadId: 'child-2', agentPath: '/root/search' })
    )
    roster.settleTurn(THREAD, TURN)

    expect(agents()).toMatchObject([
      { id: 'child-1', state: 'unverifiable' },
      { id: 'child-2', state: 'completed' }
    ])
  })

  it('lets a child swept at turn end still report what it actually did', () => {
    const { roster, agents } = createHarness()

    deliver(
      roster,
      activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    )
    roster.settleTurn(THREAD, TURN)
    expect(agents()[0]?.state).toBe('unverifiable')

    // A subagent that outlives its turn settles afterwards. Latching the sweep
    // would report a child that finished as one we never saw finish.
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
    roster.settleTurn(THREAD, TURN)
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
      activity({ kind: 'interacted', agentThreadId: 'child-1', agentPath: '/root/read' })
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

      expect(roster.handleItem({ threadId: THREAD, turnId: TURN, item })).toEqual(refusal)

      // The wire redelivers the very same item; nothing about the roster changed,
      // so only a cleared suppression state can get the revision out.
      refusing = false
      expect(roster.handleItem({ threadId: THREAD, turnId: TURN, item })).toEqual({
        accepted: true
      })
      // The retry re-appends when the publish was the half that failed; the real
      // queue coalesces those two by the group key into one journal write. What
      // must not happen is the revision never being published at all.
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
    roster.handleItem({
      threadId: THREAD,
      turnId: TURN,
      item: activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
    })
    const publishedBeforeSweep = published.length

    refusing = true
    expect(roster.settleTurn(THREAD, TURN)).toEqual({ accepted: false, reason: 'backpressure' })

    // The retry sweep flips no state — every child already latched — so only a
    // cleared suppression state can carry the unverifiable roster out.
    refusing = false
    expect(roster.settleTurn(THREAD, TURN)).toEqual({ accepted: true })
    expect(published.length).toBe(publishedBeforeSweep + 1)
    const body = appended.at(-1)?.body
    expect(body?.kind === 'message' ? body.blocks.filter(isSubagentGroupBlock) : []).toMatchObject([
      { agents: [{ id: 'child-1', state: 'unverifiable' }] }
    ])
  })

  it('propagates sink backpressure instead of reporting the row as written', () => {
    const roster = new CodexSubagentRoster({
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

    expect(
      roster.handleItem({
        threadId: THREAD,
        turnId: TURN,
        item: activity({ kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' })
      })
    ).toEqual({ accepted: false, reason: 'backpressure' })
  })
})
