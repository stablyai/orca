// The row one Orca crash leaves names the restart, whichever side of the chat's open the proof of
// the old agent's death lands on, and a reopen adds nothing.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'

// One Orca crash with a turn running: its owner is proven gone by a probe either before the chat
// opens (the lease has moved to fence 2) or after (the open still sees fence 1).
describe('an Orca crash reads as the restart whenever its proof lands', () => {
  const CRASHED: AgentSessionDeathEvidence = {
    kind: 'pid-absent',
    detail: 'recorded pid absent on host',
    observedAt: 9_000,
    ownerFence: 1,
    lastProvenAliveAt: 100
  }

  async function crashedJournal() {
    const root = await mkdtemp(join(tmpdir(), 'orca-crash-boundary-'))
    const journals = createTrackedJournalOpener()
    const journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: 'claude-1', leafUuid: null }
      },
      journalDir: root,
      now: () => 9_000
    })
    await journal.appendItem(
      { provider: 'claude', sessionId: 'claude-1', uuid: 'turn-row' },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 50 },
      { fence: 1 }
    )
    const rows = () =>
      journal
        .snapshot()
        .items.flatMap((item) =>
          item.body.kind === 'status' ? [{ itemId: item.itemId, text: item.body.text }] : []
        )
    const dispose = async () => {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
    return { journal, rows, dispose }
  }

  const restartRow = {
    itemId: agentJournalItemKey({
      provider: 'orca',
      clientMessageId: 'crash-boundary:session-1:1'
    }),
    text: "Claude's session didn't survive the restart. Send a message to continue."
  }

  it.each([
    ['before the chat opens', [{ fence: 2, deathEvidence: CRASHED, crashBoundary: true }]],
    [
      'after the chat opened',
      [
        { fence: 1, deathEvidence: null, crashBoundary: true },
        { fence: 1, deathEvidence: CRASHED, crashBoundary: false }
      ]
    ]
  ] as const)('writes the one restart row when the proof lands %s', async (_, settles) => {
    const { journal, rows, dispose } = await crashedJournal()
    try {
      const reopen = { fence: 2, deathEvidence: CRASHED, crashBoundary: true } as const
      for (const settle of [...settles, reopen]) {
        await settleStaleStructuredAgentSessionState({
          journal,
          sessionId: 'session-1',
          fence: settle.fence,
          acquisitionGeneration: null,
          deathEvidence: settle.deathEvidence,
          failureTextContext: { agentName: 'Claude' },
          ...(settle.crashBoundary ? { crashBoundary: { sendsLeftInDoubt: 0 } } : {})
        })
      }

      expect(rows()).toEqual([restartRow])
    } finally {
      await dispose()
    }
  })
})
