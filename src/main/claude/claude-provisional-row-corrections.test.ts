import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeProvisionalRowCorrections } from './claude-provisional-row-corrections'
import type { ClaudeSubagentLinkageVerdict } from './claude-subagent-linkage'

function identityOf(toolUseId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `claude-tool:claude-session:${toolUseId}` }
}

const RUNNING: AgentJournalItemBody = {
  kind: 'tool-call',
  callId: 'toolu_2',
  name: 'Task',
  input: null,
  state: 'running'
}
const COMPLETED: AgentJournalItemBody = { ...RUNNING, state: 'completed' }

/** A roster whose verdict a test moves, the way an announcement landing does. */
function ledger(initial: Record<string, ClaudeSubagentLinkageVerdict> = {}) {
  const verdicts = new Map(Object.entries(initial))
  const rewrites: {
    identity: AgentJournalItemIdentity
    body: AgentJournalItemBody
    options: StructuredAgentSessionAppendOptions
  }[] = []
  let published = 0
  /** Stands in for a sink refusing the write under backpressure. */
  let refuse = false
  const settledFor = (ref: string): ClaudeSubagentLinkageVerdict => {
    const verdict = verdicts.get(ref)
    return verdict && verdict.kind !== 'pending'
      ? verdict
      : { kind: 'linked', linkage: { agentId: ref, providerParentRef: ref, producerKind: 'agent' } }
  }
  const corrections = new ClaudeProvisionalRowCorrections({
    linkageFor: (ref) => verdicts.get(ref) ?? { kind: 'pending' },
    settledLinkageFor: (ref) => {
      const verdict = settledFor(ref)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `settledFor` returns only the linked arm, never `pending`.
      return verdict as Exclude<ClaudeSubagentLinkageVerdict, { kind: 'pending' }>
    },
    rewrite: (identity, body, options) => {
      if (refuse) {
        return false
      }
      rewrites.push({ identity, body, options })
      return true
    },
    publish: () => {
      published += 1
    }
  })
  return {
    corrections,
    rewrites,
    announce: (ref: string, agentId: string) =>
      verdicts.set(ref, {
        kind: 'linked',
        linkage: { agentId, providerParentRef: ref, producerKind: 'agent' }
      }),
    publishes: () => published,
    setRefusing: (value: boolean) => {
      refuse = value
    }
  }
}

describe('ClaudeProvisionalRowCorrections', () => {
  it("stamps the session's own rows with nothing and owes them nothing", () => {
    const { corrections, rewrites } = ledger()
    expect(corrections.stampFor(null)(identityOf('toolu_2'), RUNNING)).toEqual({})
    expect(corrections.pending).toBe(0)
    corrections.retry()
    expect(rewrites).toEqual([])
  })

  it('stamps a provisional row at once and re-attributes it on the announcement', () => {
    const { corrections, rewrites, announce } = ledger()
    const stamped = corrections.stampFor('toolu_1')(identityOf('toolu_2'), RUNNING)

    // Written immediately under the handle that exists, never withheld.
    expect(stamped).toMatchObject({ agentId: 'toolu_1' })
    expect(corrections.pending).toBe(1)

    announce('toolu_1', 'task-1')
    corrections.retry()

    expect(rewrites).toEqual([
      {
        identity: identityOf('toolu_2'),
        body: RUNNING,
        options: expect.objectContaining({ agentId: 'task-1' })
      }
    ])
    expect(corrections.pending).toBe(0)
  })

  it('drops a correction that would change nothing rather than burning a revision', () => {
    const { corrections, rewrites, publishes } = ledger()
    corrections.stampFor('toolu_1')(identityOf('toolu_2'), RUNNING)

    // Nothing ever names it, so the settled verdict equals the stamp it has.
    corrections.abandon()

    expect(rewrites).toEqual([])
    expect(publishes()).toBe(0)
  })

  it('lets a settled write supersede the correction owed to that row', () => {
    // One `itemId` can be written under two references — a tool call and its
    // result share one. A correction owed to the first must not outlive the
    // second, or it restamps the row with the body it had before.
    const { corrections, rewrites, announce } = ledger()
    corrections.stampFor('toolu_1')(identityOf('toolu_2'), RUNNING)
    expect(corrections.pending).toBe(1)

    announce('toolu_other', 'task-other')
    corrections.stampFor('toolu_other')(identityOf('toolu_2'), COMPLETED)

    expect(corrections.pending).toBe(0)
    announce('toolu_1', 'task-1')
    corrections.retry()
    expect(rewrites).toEqual([])
  })

  it('keeps a correction owed when the sink refuses it, and retries at abandon', () => {
    // Backpressure refuses the write. Deleting the entry anyway would leave a
    // durable obligation with nothing re-deriving it — the row would keep the
    // provisional id and no later pass would ever revisit it.
    const { corrections, rewrites, announce, setRefusing } = ledger()
    corrections.stampFor('toolu_1')(identityOf('toolu_2'), RUNNING)
    announce('toolu_1', 'task-1')

    setRefusing(true)
    corrections.retry()
    expect(rewrites).toEqual([])
    expect(corrections.pending).toBe(1)

    setRefusing(false)
    corrections.retry()
    expect(rewrites).toHaveLength(1)
    expect(corrections.pending).toBe(0)
  })

  it('lets a refusal at abandon end the obligation rather than leaking it', () => {
    // The last attempt. A correction that cannot be written has to die here:
    // an obligation with no exit is worse than a row keeping a usable id.
    const { corrections, rewrites, announce, setRefusing } = ledger()
    corrections.stampFor('toolu_1')(identityOf('toolu_2'), RUNNING)
    announce('toolu_1', 'task-1')

    setRefusing(true)
    corrections.abandon()

    expect(rewrites).toEqual([])
    expect(corrections.pending).toBe(0)
  })

  it('carries the NEWEST body when a row is written provisionally twice', () => {
    const { corrections, rewrites, announce } = ledger()
    const stamp = corrections.stampFor('toolu_1')
    stamp(identityOf('toolu_2'), RUNNING)
    stamp(identityOf('toolu_2'), COMPLETED)

    announce('toolu_1', 'task-1')
    corrections.retry()

    expect(rewrites).toHaveLength(1)
    expect(rewrites[0]?.body).toEqual(COMPLETED)
  })

  it('gives up on a producer WHOLESALE past the bound, never half of it', () => {
    // A partial correction splits one child across two ids in one session, which
    // is worse than correcting none: the stragglers are what a reader would have
    // to reconcile. Past the bound every row keeps the spawn call's own id.
    const { corrections, rewrites, announce } = ledger()
    const stamp = corrections.stampFor('toolu_1')
    for (let index = 0; index < 129; index += 1) {
      stamp(identityOf(`toolu_row_${index}`), RUNNING)
    }
    expect(corrections.pending).toBe(0)

    announce('toolu_1', 'task-1')
    corrections.retry()

    expect(rewrites).toEqual([])
  })

  it('keeps correcting a producer that stays inside the bound', () => {
    // The positive control for the case above: giving up must be the exception.
    const { corrections, rewrites, announce } = ledger()
    const stamp = corrections.stampFor('toolu_1')
    for (let index = 0; index < 128; index += 1) {
      stamp(identityOf(`toolu_row_${index}`), RUNNING)
    }
    expect(corrections.pending).toBe(128)

    announce('toolu_1', 'task-1')
    corrections.retry()

    expect(rewrites).toHaveLength(128)
  })
})
