import { expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  identity,
  rig
} from '../journal-ingress/testing/structured-agent-session-transition-contract.test-fixture'
import { createStructuredAgentSessionConversationReads } from './structured-agent-session-conversation-reads'

it('reads committed history while another holder keeps the chat lane', async () => {
  const { journal } = await rig()
  await journal.appendItem(
    identity('reply'),
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'PREVIOUS' }] },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 1 }
  )
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = journal.readInOrder(async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const reads = createStructuredAgentSessionConversationReads(
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an agent read uses only the conversation's journal, the store and the session map.
      ({
        conversation: async () => ({ journal }),
        sessions: new Map(),
        seal() {},
        deps: { store: { getRecord: () => null } }
      }) as never
  )
  try {
    await expect(reads.agentReadPage(journal.identity.sessionId, 1)).resolves.toEqual({
      entries: [{ kind: 'message', role: 'assistant', text: 'PREVIOUS' }],
      limited: false
    })
  } finally {
    release.resolve()
    await held
  }
})
