import { expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  loadTestJournal,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend
} from './structured-agent-session-rest-test-rig'

it.each(['git-worktree', 'folder'] as const)(
  'captures resting %s attention without waking the provider or reading a different scope',
  async (workspaceKind) => {
    const rig = await createRestTestRig()
    const location: AgentSessionExecutionLocation = { ...HOST_TEST_LOCATION, workspaceKind }
    try {
      const attached = await rig.host.attach(
        REST_TEST_CALLER,
        hostTestAttachParams(null, { location })
      )
      if (!attached.ok) {
        throw new Error(`attach refused: ${attached.refusal.code}`)
      }
      expect(
        await rig.host.send(REST_TEST_CALLER, restTestSend('read this work', attached.fence))
      ).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalled())
      await rig.restart()
      const stored = loadTestJournal(rig.root, SESSION)
      if (!stored) {
        throw new Error('the conversation has no stored journal')
      }
      const acquisitions = rig.adapter.acquire.mock.calls.length

      expect(await rig.host.attentionReads.workspace(location)).toEqual([
        {
          sessionId: SESSION,
          scope: location,
          observedCursor: { epoch: stored.state.epoch, sequence: stored.state.lastSequence }
        }
      ])
      for (const other of [
        { ...location, workspaceId: 'different-workspace' },
        { ...location, executionHostId: 'ssh:other' as const },
        { ...location, wslDistro: 'Ubuntu' },
        {
          ...location,
          workspaceKind:
            workspaceKind === 'folder' ? ('git-worktree' as const) : ('folder' as const)
        }
      ]) {
        expect(await rig.host.attentionReads.workspace(other)).toEqual([])
      }
      expect(rig.host.loadedSessionIds()).toEqual([])
      expect(rig.host.hasSession(SESSION)).toBe(false)
      expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
    } finally {
      await rig.dispose()
    }
  }
)

it('keeps an accepted attention boundary fixed when the loaded conversation advances', async () => {
  const rig = await createRestTestRig()
  try {
    const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
    if (!attached.ok) {
      throw new Error(`attach refused: ${attached.refusal.code}`)
    }
    const [read] = await rig.host.attentionReads.workspace(HOST_TEST_LOCATION)
    expect(read?.observedCursor.sequence).toBeGreaterThan(0)
    const acceptedSequence = read.observedCursor.sequence

    expect(
      await rig.host.send(REST_TEST_CALLER, restTestSend('newer unread work', attached.fence))
    ).toMatchObject({ ok: true })
    const [later] = await rig.host.attentionReads.workspace(HOST_TEST_LOCATION)
    expect(later.observedCursor.epoch).toBe(read.observedCursor.epoch)
    expect(later.observedCursor.sequence).toBeGreaterThan(acceptedSequence)
    expect(read.observedCursor.sequence).toBe(acceptedSequence)
  } finally {
    await rig.dispose()
  }
})

it.each(['resting-newer-format', 'live-closed'] as const)(
  'keeps sibling attention readable when a %s journal cannot supply its boundary',
  async (failure) => {
    const rig = await createRestTestRig()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const damaged = 'session-unreadable'
    try {
      const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
      expect(attached.ok).toBe(true)
      await rig.store.reserveOwner({
        sessionId: damaged,
        location: HOST_TEST_LOCATION,
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
        expectedFence: null,
        spawnToken: 'unreadable-chat',
        claimKeyId: 'key-1',
        handoffOperationId: null,
        probe: { outcome: 'reservation-unused' },
        operation: {
          callerKey: 'fixture',
          operationId: hostTestOperationId(),
          fingerprint: '1'.repeat(64)
        },
        now: rig.clock.now
      })
      expect(await rig.host.revealSession(damaged)).toMatchObject({ readable: true })
      if (failure === 'resting-newer-format') {
        await rig.restart()
      }
      const accepted = (await rig.host.attentionReads.workspace(HOST_TEST_LOCATION)).find(
        (read) => read.sessionId === SESSION
      )
      expect(accepted).toBeDefined()
      if (failure === 'resting-newer-format') {
        openTestJournalHostDatabase(rig.root)
          .db.prepare('UPDATE journal_outcome_epochs SET format = format + 1 WHERE session_id = ?')
          .run(damaged)
      } else {
        await rig.host.collaboratorsForTests().sessions.get(damaged)?.journal.close()
      }

      expect(await rig.host.attentionReads.workspace(HOST_TEST_LOCATION)).toEqual([accepted])
      expect(warn).toHaveBeenCalled()
    } finally {
      await rig.dispose()
      warn.mockRestore()
    }
  }
)
