import { describe, expect, it } from 'vitest'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalProducerLinkage } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionAppendOptions } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import type {
  ClaudeSubagentLinkageSource,
  ClaudeSubagentLinkageVerdict
} from '../../subagents/claude-subagent-linkage'

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
})
