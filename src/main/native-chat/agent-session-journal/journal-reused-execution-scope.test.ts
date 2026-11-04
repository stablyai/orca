import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { latestUsageLimitContinueIdentity } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { journalInputOrder } from './journal-input-order'

for (const nextFence of [0, 1]) {
  it(`new provider output belongs to the replacement execution (fence=${nextFence})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr37743-reused-scope-'))
    const journals = createTrackedJournalOpener()
    const input = {
      identity: {
        sessionId: 'scope',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'claude' as const,
        providerHandle: claudeProviderHandle('thread', null)
      },
      stateDirectory: root
    }
    let journal = await journals.open(input)
    const identity = { provider: 'claude' as const, sessionId: 'thread', uuid: 'turn-B' }
    const oldId = agentJournalItemKey(identity)
    try {
      await journal.appendItem(
        identity,
        { kind: 'turn', turnId: 'B', state: 'completed' },
        { fence: 0, turnScope: { kind: 'thread' } }
      )
      await journal.appendSubmission({
        clientMessageId: 'fresh',
        payloadFingerprint: 'fresh',
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: nextFence
      })
      await journal.resolveDispatch({
        clientMessageId: 'fresh',
        state: 'accepted',
        providerIdentity: null,
        fence: nextFence
      })
      const nextBody = {
        kind: 'turn' as const,
        turnId: 'B',
        userItemId: agentJournalSubmissionKey('fresh')
      }
      await journal.appendItem(
        identity,
        { ...nextBody, state: 'running' },
        { fence: nextFence, executionOwner: nextFence, turnScope: { kind: 'thread' } }
      )
      const freshId = journal.canonicalItemId(oldId)
      await journal.appendLifecycleBatch({
        settlementId: 'exact-old-history',
        fence: nextFence,
        mutations: [
          {
            kind: 'item',
            itemId: oldId,
            body: { kind: 'turn', turnId: 'B', state: 'completed' },
            turnScope: { kind: 'thread' }
          }
        ]
      })
      await journal.appendItem(
        { provider: 'claude', sessionId: 'thread', uuid: 'fresh-limit' },
        {
          kind: 'status',
          ...agentSessionFailureWords(
            agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 5000 } }),
            { surface: 'row' }
          )
        },
        { fence: nextFence, ownerFence: nextFence, turnScope: { kind: 'turn', turnItemId: oldId } }
      )
      await journal.appendItem(
        identity,
        { ...nextBody, state: 'completed', outcome: 'failure' },
        { fence: nextFence, executionOwner: nextFence, turnScope: { kind: 'thread' } }
      )
      const cut = () =>
        journal.queuedMessages.inputState().items.get(
          agentJournalItemKey({
            provider: 'claude',
            sessionId: 'thread',
            uuid: 'fresh-limit'
          })
        )?.turnScope
      expect(cut()).toEqual({ kind: 'turn', turnItemId: freshId })
      const expectedCut = { turnItemId: freshId, resetsAt: 5000 }
      expect(latestUsageLimitContinueIdentity(journal.snapshot())).toEqual(expectedCut)
      expect(
        journalInputOrder(journal.queuedMessages.inputState()).newestTurn.usageLimitCut.read()
      ).toEqual(expectedCut)
      await journals.closeAll()
      journal = await journals.open(input)
      expect(cut()).toEqual({ kind: 'turn', turnItemId: freshId })
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })
}
