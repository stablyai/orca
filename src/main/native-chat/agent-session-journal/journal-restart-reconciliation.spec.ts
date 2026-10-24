import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { digestPayload } from './journal-payload-bounds'
import { reconcileJournalSubmissionsAgainstHistory } from './journal-restart-reconciliation'
import type { ProviderHistoryItem, ProviderHistoryWindow } from './journal-submission-reconciler'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

export function registerJournalRestartReconciliationTests(): void {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: claudeProviderHandle('provider-1', null)
  }

  function claudeIdentity(uuid: string): AgentJournalItemIdentity {
    return { provider: 'claude', sessionId: 'provider-1', uuid }
  }

  let root: string
  let clock = 1_000

  function tick(): number {
    clock += 1
    return clock
  }

  function userMessage(text: string): AgentJournalMessageItem {
    return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }

  const journals = createTrackedJournalOpener()

  async function open() {
    return journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: tick,
      mintEpoch: () => `epoch-${clock}`
    })
  }

  function history(uuid: string, text: string): ProviderHistoryItem {
    return {
      providerItemId: uuid,
      clientMessageId: null,
      payloadFingerprint: digestPayload(text),
      identity: claudeIdentity(uuid)
    }
  }

  function window(
    items: ProviderHistoryItem[],
    overrides: Partial<ProviderHistoryWindow> = {}
  ): ProviderHistoryWindow {
    return { items, boundaryConsistent: true, turnInFlight: false, ...overrides }
  }

  async function reopenAfterCrash(
    body: AgentJournalMessageItem = userMessage('deploy the thing'),
    text = 'deploy the thing'
  ) {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_1',
      payloadFingerprint: digestPayload(text),
      body,
      fence: 1
    })
    const restarted = await open()
    await restarted.markPendingSubmissionsUnknown(2)
    return restarted
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-restart-reconcile-'))
    clock = 1_000
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('reconcileJournalSubmissionsAgainstHistory', () => {
    it('settles a message found in provider history as accepted on its provider identity', async () => {
      const journal = await reopenAfterCrash()

      const settled = await reconcileJournalSubmissionsAgainstHistory({
        journal,
        fence: 2,
        history: window([history('uuid-1', 'deploy the thing')])
      })

      expect(settled).toEqual(['cm_1'])
      const submission = journal.submissions()[0]
      expect(submission?.dispatchState).toBe('accepted')
      expect(submission?.providerItemId).toBe(agentJournalItemKey(claudeIdentity('uuid-1')))
    })

    it('settles a message provably absent from history as rejected: not_delivered', async () => {
      const journal = await reopenAfterCrash()

      const settled = await reconcileJournalSubmissionsAgainstHistory({
        journal,
        fence: 2,
        history: window([])
      })

      expect(settled).toEqual(['cm_1'])
      const submission = journal.submissions()[0]
      expect(submission?.dispatchState).toBe('rejected')
      // Released clients display reason text directly; preserve wording beside typed facts.
      expect(submission?.reason).toBe(
        agentSessionFailureWords(agentSessionFailureFact('notDelivered'), { surface: 'rejection' })
          .reason
      )
      expect(submission?.rejection).toEqual({ kind: 'notDelivered' })
      expect(submission && classifyDispatchRejection(submission)).toEqual({
        category: 'undelivered',
        verdict: null,
        kind: 'notDelivered'
      })
    })

    it('leaves a submission unknown while the provider reports a turn in flight', async () => {
      const journal = await reopenAfterCrash()

      const settled = await reconcileJournalSubmissionsAgainstHistory({
        journal,
        fence: 2,
        history: window([], { turnInFlight: true })
      })

      expect(settled).toEqual([])
      expect(journal.submissions()[0]?.dispatchState).toBe('unknown')
    })

    it('leaves a submission unknown when the history boundary is inconsistent', async () => {
      const journal = await reopenAfterCrash()

      const settled = await reconcileJournalSubmissionsAgainstHistory({
        journal,
        fence: 2,
        history: window([], { boundaryConsistent: false })
      })

      expect(settled).toEqual([])
      expect(journal.submissions()[0]?.dispatchState).toBe('unknown')
    })

    it('refuses to reject a submission carrying an attachment it cannot fingerprint', async () => {
      const journal = await reopenAfterCrash(
        {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'text', text: 'look at this' },
            { type: 'image-ref', path: '/tmp/shot.png' }
          ]
        },
        'look at this'
      )

      const settled = await reconcileJournalSubmissionsAgainstHistory({
        journal,
        fence: 2,
        history: window([])
      })

      expect(settled).toEqual([])
      expect(journal.submissions()[0]?.dispatchState).toBe('unknown')
    })

    it('leaves a send that carried stopped history unknown: its provider copy leads with that history', async () => {
      const journal = await open()
      for (const clientMessageId of ['stopped', 'cm_1']) {
        await journal.appendSubmission({
          clientMessageId,
          payloadFingerprint: digestPayload(clientMessageId),
          body: userMessage(clientMessageId),
          fence: 1,
          handoverRecorded: true
        })
      }
      await journal.resolveDispatch({
        clientMessageId: 'cm_1',
        state: 'pending',
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        carries: ['stopped']
      })
      const restarted = await open()
      await restarted.markPendingSubmissionsUnknown(2)

      const settled = await reconcileJournalSubmissionsAgainstHistory({
        journal: restarted,
        fence: 2,
        history: window([])
      })

      expect(settled).toEqual([])
      expect(restarted.submission('cm_1')?.dispatchState).toBe('unknown')
      expect(restarted.stoppedHistoryCarried().get('cm_1')).toEqual(['stopped'])
    })

    it('leaves multi-block text sends unknown because Claude joins them before recording history', async () => {
      const journal = await reopenAfterCrash(
        {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' }
          ]
        },
        'first\nsecond'
      )

      const settled = await reconcileJournalSubmissionsAgainstHistory({
        journal,
        fence: 2,
        history: window([history('uuid-1', 'first\nsecond')])
      })

      expect(settled).toEqual([])
      expect(journal.submissions()[0]?.dispatchState).toBe('unknown')
    })

    it('does not let an item the journal already committed stand in for a new send', async () => {
      const journal = await open()
      await journal.appendItem(claudeIdentity('uuid-old'), userMessage('deploy the thing'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.appendSubmission({
        clientMessageId: 'cm_1',
        payloadFingerprint: digestPayload('deploy the thing'),
        body: userMessage('deploy the thing'),
        fence: 1
      })
      const restarted = await open()
      await restarted.markPendingSubmissionsUnknown(2)

      await reconcileJournalSubmissionsAgainstHistory({
        journal: restarted,
        fence: 2,
        history: window([history('uuid-old', 'deploy the thing')])
      })

      expect(restarted.submissions()[0]?.dispatchState).toBe('rejected')
    })

    it('does not let an older accepted provider item stand in for a new identical send', async () => {
      const journal = await open()
      await journal.appendSubmission({
        clientMessageId: 'cm_old',
        payloadFingerprint: digestPayload('deploy the thing'),
        body: userMessage('deploy the thing'),
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'cm_old',
        state: 'accepted',
        providerIdentity: claudeIdentity('uuid-old'),
        fence: 1
      })
      await journal.appendSubmission({
        clientMessageId: 'cm_new',
        payloadFingerprint: digestPayload('deploy the thing'),
        body: userMessage('deploy the thing'),
        fence: 1
      })
      const restarted = await open()
      await restarted.markPendingSubmissionsUnknown(2)

      await reconcileJournalSubmissionsAgainstHistory({
        journal: restarted,
        fence: 2,
        history: window([history('uuid-old', 'deploy the thing')])
      })

      expect(restarted.submissions().map((entry) => entry.dispatchState)).toEqual([
        'accepted',
        'rejected'
      ])
      expect(restarted.submissions()[1]?.rejection).toEqual({ kind: 'notDelivered' })
    })

    it('leaves two identical unsettled sends unknown rather than guessing between them', async () => {
      const journal = await open()
      for (const id of ['cm_1', 'cm_2']) {
        await journal.appendSubmission({
          clientMessageId: id,
          payloadFingerprint: digestPayload('ping'),
          body: userMessage('ping'),
          fence: 1
        })
      }
      const restarted = await open()
      await restarted.markPendingSubmissionsUnknown(2)

      await reconcileJournalSubmissionsAgainstHistory({
        journal: restarted,
        fence: 2,
        history: window([history('uuid-1', 'ping'), history('uuid-2', 'ping')])
      })

      expect(restarted.submissions().map((entry) => entry.dispatchState)).toEqual([
        'unknown',
        'unknown'
      ])
    })
  })
}
