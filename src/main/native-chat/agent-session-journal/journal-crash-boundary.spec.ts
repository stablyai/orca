// The crash boundary: the host wrote a submission row, dispatched, and died
// before it learned whether the provider took the message. Replay keeps the message, once, in
// doubt: it is neither re-sent nor guessed undelivered.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { hasUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-projection'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { digestPayload } from './journal-payload-bounds'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

export function registerJournalCrashBoundaryTests(): void {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread-1')
  }

  const TURN_ID = '019fd8ca-edbe-7c43-b231-4c7aea3a2d89'

  const ACCEPTED_IDENTITY: AgentJournalItemIdentity = {
    provider: 'codex',
    threadId: 'thread-1',
    turnId: TURN_ID,
    ordinal: 0
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

  const LEGACY_CODEX_TURN_UNNAMED = 'codex app-server started a turn it did not name in time'

  const journals = createTrackedJournalOpener()

  async function open() {
    return journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: tick,
      mintEpoch: () => `epoch-${clock}`
    })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-crash-'))
    clock = 1_000
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('crash between provider accept and journal commit', () => {
    it('keeps a crash-cut send as one bubble in doubt, neither re-sent nor called undelivered', async () => {
      const journal = await open()
      await journal.appendSubmission({
        clientMessageId: 'cm_1',
        payloadFingerprint: digestPayload('deploy the thing'),
        body: userMessage('deploy the thing'),
        fence: 1
      })
      // Host dies here: the provider may have taken it, but no dispatch row was written.

      const restarted = await open()
      expect(restarted.pendingSubmissions().map((entry) => entry.clientMessageId)).toEqual(['cm_1'])
      await restarted.markPendingSubmissionsUnknown(2)
      expect(restarted.submissions()[0]).toMatchObject({
        dispatchState: 'unknown',
        recovered: true
      })
      // Outlived by its writer, so no reader reports it as still working.
      expect(hasUnansweredStructuredAgentSessionDispatch(restarted.submissions())).toBe(false)
      expect(restarted.snapshot().items.map((item) => item.itemId)).toEqual([
        agentJournalSubmissionKey('cm_1')
      ])
    })

    it('retires an ack timeout on restart without changing its delivery verdict', async () => {
      const journal = await open()
      await journal.appendSubmission({
        clientMessageId: 'cm_timeout',
        payloadFingerprint: digestPayload('slow'),
        body: userMessage('slow'),
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'cm_timeout',
        state: 'unknown',
        reason: 'ack timeout',
        fence: 1
      })
      expect(hasUnansweredStructuredAgentSessionDispatch(journal.submissions())).toBe(true)
      const restarted = await open()
      await restarted.markPendingSubmissionsUnknown(2)
      expect(restarted.submissions()[0]?.dispatchState).toBe('unknown')
      expect(hasUnansweredStructuredAgentSessionDispatch(restarted.submissions())).toBe(false)
      const cursor = restarted.cursor()
      await restarted.markPendingSubmissionsUnknown(2)
      expect(restarted.cursor()).toEqual(cursor)
    })

    it('leaves a rejected write failure settled across a restart', async () => {
      const journal = await open()
      await journal.appendSubmission({
        clientMessageId: 'cm_write_failed',
        payloadFingerprint: digestPayload('never left the process'),
        body: userMessage('never left the process'),
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'cm_write_failed',
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), {
          surface: 'rejection'
        }),
        fence: 1
      })

      const restarted = await open()
      await restarted.markPendingSubmissionsUnknown(2)

      // Recovery must preserve settled rejection instead of reopening it as unknown.
      expect(restarted.submissions()[0]).toMatchObject({
        dispatchState: 'rejected',
        reason: 'provider_write_failed'
      })
      expect(restarted.submissions()[0]?.recovered).toBeUndefined()
      expect(hasUnansweredStructuredAgentSessionDispatch(restarted.submissions())).toBe(false)
    })

    // Older Codex rows retain this uncertainty reason even though current sends settle on echoes.
    it('keeps a codex turn it could not name in doubt, never rejected', async () => {
      const journal = await open()
      await journal.appendSubmission({
        clientMessageId: 'cm_codex_unnamed',
        payloadFingerprint: digestPayload('codex is running this'),
        body: userMessage('codex is running this'),
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'cm_codex_unnamed',
        state: 'unknown',
        reason: LEGACY_CODEX_TURN_UNNAMED,
        fence: 1
      })

      const restarted = await open()
      await restarted.markPendingSubmissionsUnknown(2, 'provider_exited_before_acknowledgement')

      // Preserve proven turn start; rejection would incorrectly authorize redelivery.
      // and it may never become a rejection, which would license a re-delivery.
      expect(restarted.submissions()[0]).toMatchObject({
        dispatchState: 'unknown',
        reason: LEGACY_CODEX_TURN_UNNAMED,
        recovered: true
      })
    })

    it('survives replay of an already-settled journal without changing the answer', async () => {
      const journal = await open()
      await journal.appendSubmission({
        clientMessageId: 'cm_1',
        payloadFingerprint: digestPayload('once'),
        body: userMessage('once'),
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'cm_1',
        state: 'accepted',
        providerIdentity: ACCEPTED_IDENTITY,
        fence: 1
      })
      const settled = journal.snapshot()

      const reopened = await open()
      expect(reopened.snapshot()).toEqual(settled)
      expect(reopened.pendingSubmissions()).toHaveLength(0)
    })

    it('keeps the receipt across a reopen', async () => {
      const journal = await open()
      await journal.appendSubmission({
        clientMessageId: 'cm_1',
        payloadFingerprint: digestPayload('kept'),
        body: userMessage('kept'),
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'cm_1',
        state: 'accepted',
        providerIdentity: ACCEPTED_IDENTITY,
        fence: 1
      })
      await journal.close()

      const reopened = await open()
      expect(reopened.receiptFor('cm_1')?.providerItemId).toBe(
        agentJournalItemKey(ACCEPTED_IDENTITY)
      )
    })
  })
}
