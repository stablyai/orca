import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import type {
  ClaudeSubagentLinkageSource,
  ClaudeSubagentLinkageVerdict
} from './claude-subagent-linkage'

function identityOf(uuid: string): AgentJournalItemIdentity {
  return { provider: 'claude', sessionId: 'claude-session', uuid }
}

/** Scopeless blocks are root-owned and must never consult the child resolver. */
const unconsultedProducer: ClaudeSubagentLinkageSource = {
  linkageFor: () => {
    throw new Error('resolver consulted for a block with no scope')
  },
  settledLinkageFor: () => {
    throw new Error('resolver consulted for a block with no scope')
  }
}

const CHILD_LINKAGE: AgentJournalProducerLinkage = {
  agentId: 'task-1',
  providerParentRef: 'toolu_1',
  producerKind: 'agent'
}

/** Resolve announcements mid-stream; use the raw reference if no announcement arrives. */
function scriptedProducer() {
  let verdict: ClaudeSubagentLinkageVerdict = { kind: 'pending' }
  const settledFallback: Extract<ClaudeSubagentLinkageVerdict, { kind: 'linked' }> = {
    kind: 'linked',
    linkage: { agentId: 'toolu_1', providerParentRef: 'toolu_1', producerKind: 'agent' }
  }
  return {
    source: {
      linkageFor: () => verdict,
      settledLinkageFor: () => (verdict.kind === 'pending' ? settledFallback : verdict)
    } satisfies ClaudeSubagentLinkageSource,
    resolve: (linkage: AgentJournalProducerLinkage) => {
      verdict = { kind: 'linked', linkage }
    }
  }
}

function checkpoints(producer: ClaudeSubagentLinkageSource = unconsultedProducer) {
  const rows: { uuid: string; text: string }[] = []
  const stamps: StructuredAgentSessionAppendOptions[] = []
  let scheduled: (() => void) | null = null
  const store = createClaudeStreamedTextCheckpoints({
    producer,
    persist: (identity, text, options) => {
      rows.push({ uuid: 'uuid' in identity ? identity.uuid : '', text })
      stamps.push(options)
    },
    schedule: (run) => {
      scheduled = run
      return () => {
        scheduled = null
      }
    }
  })
  return {
    store,
    rows,
    stamps,
    runWindow: () => {
      const run = scheduled as (() => void) | null
      run?.()
    }
  }
}

describe('claude streamed text checkpoints', () => {
  it('rewrites a block row with the full text accumulated so far', () => {
    const { store, rows, runWindow } = checkpoints()

    store.append(identityOf('block-1'), 'hel')
    store.append(identityOf('block-1'), 'lo')
    runWindow()

    expect(rows).toEqual([{ uuid: 'block-1', text: 'hello' }])
    expect(store.pending).toBe(1)
  })

  it('drops every block still awaiting its final frame at settlement', () => {
    const { store, rows, runWindow } = checkpoints()

    store.append(identityOf('block-1'), 'partial answer')
    runWindow()
    store.settle()

    expect(store.pending).toBe(0)
    store.flush()
    expect(rows).toEqual([{ uuid: 'block-1', text: 'partial answer' }])
  })

  it('keeps a block whose final frame arrived out of the settlement sweep', () => {
    const { store } = checkpoints()

    store.append(identityOf('block-1'), 'one')
    store.append(identityOf('block-2'), 'two')
    store.forget('claude:claude-session:block-1')

    expect(store.pending).toBe(1)
    store.settle()
    expect(store.pending).toBe(0)
  })

  it('flushes text the widening checkpoint interval has not written yet', () => {
    const { store, rows } = checkpoints()

    store.append(identityOf('block-1'), 'x')
    store.flush()

    expect(rows).toEqual([{ uuid: 'block-1', text: 'x' }])
    store.flush()
    expect(rows).toHaveLength(1)
  })

  it("stamps a block streamed inside a child with that child's linkage", () => {
    const producer = scriptedProducer()
    producer.resolve(CHILD_LINKAGE)
    const { store, rows, stamps, runWindow } = checkpoints(producer.source)

    store.append(identityOf('block-1'), 'hello', 'toolu_1')
    runWindow()

    expect(rows).toEqual([{ uuid: 'block-1', text: 'hello' }])
    expect(stamps).toEqual([CHILD_LINKAGE])
  })

  it("writes no linkage keys for a block the session's own agent streamed", () => {
    const { store, stamps, runWindow } = checkpoints()

    store.append(identityOf('block-1'), 'hello')
    runWindow()

    expect(stamps).toEqual([{}])
  })

  it('writes a checkpoint at once while the producing agent is provisional', () => {
    const producer = scriptedProducer()
    const { store, rows, stamps, runWindow } = checkpoints(producer.source)

    store.append(identityOf('block-1'), 'partial', 'toolu_1')
    runWindow()
    expect(rows).toEqual([{ uuid: 'block-1', text: 'partial' }])
    expect(stamps.at(-1)).toMatchObject({ agentId: 'toolu_1' })

    // Flush advances text; reattribute corrects linkage even when text is unchanged.
    producer.resolve(CHILD_LINKAGE)
    store.flush()
    expect(stamps.at(-1)).toMatchObject({ agentId: 'toolu_1' })

    store.reattribute()

    expect(rows.at(-1)).toEqual({ uuid: 'block-1', text: 'partial' })
    expect(stamps.at(-1)).toEqual(CHILD_LINKAGE)
  })

  it('writes a held block under the raw reference when no announcement comes', () => {
    const producer = scriptedProducer()
    const { store, rows, stamps, runWindow } = checkpoints(producer.source)

    store.append(identityOf('block-1'), 'never announced', 'toolu_1')
    runWindow()

    expect(rows).toEqual([{ uuid: 'block-1', text: 'never announced' }])
    expect(stamps).toEqual([
      { agentId: 'toolu_1', providerParentRef: 'toolu_1', producerKind: 'agent' }
    ])

    store.reattribute()
    expect(rows).toHaveLength(1)
  })

  it('re-resolves a block’s producer on every checkpoint', () => {
    const producer = scriptedProducer()
    producer.resolve(CHILD_LINKAGE)
    const { store, stamps, runWindow } = checkpoints(producer.source)

    store.append(identityOf('block-1'), 'first', 'toolu_1')
    runWindow()
    producer.resolve({ ...CHILD_LINKAGE, agentId: 'task-2' })
    store.append(identityOf('block-1'), 'first and more', 'toolu_1')
    store.flush()

    expect(stamps).toEqual([CHILD_LINKAGE, { ...CHILD_LINKAGE, agentId: 'task-2' }])
  })

  it('stops persisting once disposed', () => {
    const { store, rows, runWindow } = checkpoints()

    store.append(identityOf('block-1'), 'text')
    store.dispose()
    runWindow()
    store.flush()

    expect(rows).toEqual([])
    expect(store.pending).toBe(0)
  })
})
