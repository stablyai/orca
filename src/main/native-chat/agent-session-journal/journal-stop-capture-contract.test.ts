import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { createTrackedJournalOpener } from './journal-host-database-test-support'

for (const withCut of [false, true]) {
  it(`unnamed Stop captures the accepted unopened command opener (cut=${withCut})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'close3-probe-'))
    const journals = createTrackedJournalOpener()
    const journal = await journals.open({
      identity: {
        sessionId: 'probe',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'claude' as const,
        providerHandle: claudeProviderHandle('thread', null)
      },
      stateDirectory: root
    })
    const options = { fence: 0, turnScope: { kind: 'thread' as const } }
    const turnB = { provider: 'claude' as const, sessionId: 'thread', uuid: 'turn-B' }
    try {
      await journal.appendItem(turnB, { kind: 'turn', turnId: 'B', state: 'running' }, options)
      await journal.appendItem(
        turnB,
        { kind: 'turn', turnId: 'B', state: 'completed', outcome: 'failure', completedAt: 900 },
        options
      )
      if (withCut) {
        await journal.appendItem(
          { provider: 'orca', clientMessageId: 'limit' },
          {
            kind: 'status',
            ...agentSessionFailureWords(
              agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 5000 } }),
              { surface: 'row' }
            )
          },
          { fence: 0, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turnB) } }
        )
      }
      await journal.appendSubmission({
        clientMessageId: 'compact',
        payloadFingerprint: 'compact',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/compact' }],
          command: { name: 'compact' }
        },
        fence: 0,
        handoverRecorded: true
      })
      await journal.resolveDispatch({ clientMessageId: 'compact', state: 'pending', ...options })
      await journal.resolveDispatch({
        clientMessageId: 'compact',
        state: 'accepted',
        providerIdentity: null,
        fence: 0
      })
      await journal.appendStopEvent({ reason: 'user-stop' }, 0)
      const pending = journal.stopMarks.cancellations()
      expect(pending.map((p) => p.target?.clientMessageId)).toContain('compact')
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })
}

it('a streamed turn row never copies untouched retained graph entries', async () => {
  const copied: number[] = []
  for (const n of [200, 2000]) {
    const root = await mkdtemp(join(tmpdir(), 'close3-scale-'))
    const journals = createTrackedJournalOpener()
    const journal = await journals.open({
      identity: {
        sessionId: 'scale',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'claude' as const,
        providerHandle: claudeProviderHandle('thread', null)
      },
      stateDirectory: root
    })
    const options = { fence: 0, turnScope: { kind: 'thread' as const } }
    try {
      for (let i = 0; i < n; i++) {
        const id = { provider: 'claude' as const, sessionId: 'thread', uuid: `t${i}` }
        await journal.appendItem(id, { kind: 'turn', turnId: `t${i}`, state: 'completed' }, options)
      }
      const assign = Object.assign
      let keys = 0
      const spy = vi.spyOn(Object, 'assign').mockImplementation((target, ...sources) => {
        for (const s of sources) {
          if (s && Object.keys(s).some((k) => k.startsWith('turn:'))) {
            keys += Object.keys(s).length
          }
        }
        return assign(target, ...sources)
      })
      try {
        const probe = { provider: 'claude' as const, sessionId: 'thread', uuid: 'probe' }
        await journal.appendItem(
          probe,
          { kind: 'turn', turnId: 'probe', state: 'running' },
          options
        )
      } finally {
        spy.mockRestore()
      }
      copied.push(keys)
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
  expect(copied).toEqual([0, 0])
}, 300_000)
