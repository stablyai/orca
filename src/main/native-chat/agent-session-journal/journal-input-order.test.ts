import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { holdUnsentSends } from './journal-unsent-send-hold'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import {
  selectedStructuredSubmission,
  selectStructuredAgentSessionInput
} from '../agent-session-wire/structured-agent-session-input-selection'

it('preserves the forced queue place through command removal, two epoch replacements, replay and recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-input-order-'))
  const journals = createTrackedJournalOpener()
  const identity = {
    sessionId: 'order',
    workspaceId: 'folder',
    hostId: 'ssh',
    agent: 'claude' as const,
    providerHandle: claudeProviderHandle('thread', null)
  }
  const message = (text: string): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })
  const journal = await journals.open({ identity, stateDirectory: root })
  try {
    const c = await journal.queuedMessages.insert({
      messageId: 'C',
      body: { ...message('/compact'), command: { name: 'compact' } }
    })
    await journal.queuedMessages.insert({ messageId: 'D', body: message('earlier card') })
    await journal.appendSubmission({
      clientMessageId: 'M',
      body: message('stale direct'),
      payloadFingerprint: 'M',
      fence: 0,
      handoverRecorded: true,
      origin: 'client'
    })
    await journal.queuedMessages.insert({ messageId: 'later', body: message('later card') })
    await journal.queuedMessages.withdraw([c.messageId])
    expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
      kind: 'card',
      card: { messageId: 'D' }
    })
    for (let round = 0; round < 2; round++) {
      await journal.replaceEpochItems('unreconcilable_prefix', 0, [])
      expect(journal.inputOrder.prefix('M').map((card) => card.messageId)).toEqual(['C', 'D'])
      expect(journal.queuedMessages.get('C')?.state).toBe('withdrawn')
      expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
        kind: 'card',
        card: { messageId: 'D' }
      })
    }
    await journal.close()
    const reopened = await journals.open({ identity, stateDirectory: root })
    expect(reopened.inputOrder.prefix('M').map((card) => card.messageId)).toEqual(['C', 'D'])
    await holdUnsentSends(reopened, { fence: 0, hold: { cause: 'hostRestarted' } })
    expect(
      reopened.queuedMessages
        .list()
        .filter((card) => card.state === 'waiting')
        .map((card) => card.messageId)
    ).toEqual(['D', 'M', 'later'])
    expect(reopened.submission('M')).toMatchObject({
      dispatchState: 'rejected',
      keptAsQueuedMessageId: 'M'
    })
    expect(selectedStructuredSubmission(reopened)).toBeUndefined()
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
