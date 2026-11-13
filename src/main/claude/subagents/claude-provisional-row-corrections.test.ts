import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionAppendOptions } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
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

function ledger(initial: Record<string, ClaudeSubagentLinkageVerdict> = {}) {
  const verdicts = new Map(Object.entries(initial))
  const rewrites: {
    identity: AgentJournalItemIdentity
    body: AgentJournalItemBody
    options: StructuredAgentSessionAppendOptions
  }[] = []
  let published = 0
  let refuse = false
  const settledFor = (ref: string): ClaudeSubagentLinkageVerdict => {
    const verdict = verdicts.get(ref)
    return verdict && verdict.kind !== 'pending'
      ? verdict
      : { kind: 'linked', linkage: { agentId: ref, providerParentRef: ref, producerKind: 'agent' } }
  }
  const corrections = new ClaudeProvisionalRowCorrections({
    turnScope: () => AGENT_JOURNAL_THREAD_SCOPE,
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
})
