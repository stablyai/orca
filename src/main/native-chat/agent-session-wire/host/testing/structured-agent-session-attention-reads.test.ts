import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { structuredAttentionOrigin } from '../../../../../shared/agent-session/agent-session-attention'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { createAnnouncedNotificationRegistry } from '../../../../notifications/announced-notification-registry'
import * as journalFactory from '../../../agent-session-journal/journal-store-factory'
import type { AgentSessionExecutionLocation } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import { journalSqlReads } from '../../../agent-session-journal/journal-sql-reads'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend,
  sweepOnce
} from './structured-agent-session-rest-test-rig.test-fixture'

import { STRUCTURED_AGENT_SESSION_IDLE_MS as IDLE_MS } from '../../termination/structured-agent-session-idle-sweep'

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
      const stored = await journalSqlReads(rig.host.deps.journalDatabase.readers, SESSION).cursor()
      const acquisitions = rig.adapter.acquire.mock.calls.length

      expect(await rig.host.attentionReads.workspace(location)).toEqual([
        {
          sessionId: SESSION,
          scope: location,
          observedCursor: stored
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

it('keeps sibling attention readable when a closed live journal cannot supply its boundary', async () => {
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
    const accepted = (await rig.host.attentionReads.workspace(HOST_TEST_LOCATION)).find(
      (read) => read.sessionId === SESSION
    )
    expect(accepted).toBeDefined()
    await rig.host.collaboratorsForTests().sessions.get(damaged)?.journal.close()

    expect(await rig.host.attentionReads.workspace(HOST_TEST_LOCATION)).toEqual([accepted])
    expect(warn).toHaveBeenCalled()
  } finally {
    await rig.dispose()
    warn.mockRestore()
  }
})

it('acknowledges a post-rewind completion after normal idle retirement without reopening history', async () => {
  const rig = await createRestTestRig()
  try {
    const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
    if (!attached.ok) {
      throw new Error(`attach refused: ${attached.refusal.code}`)
    }
    rig.host.collaboratorsForTests().lifetime.idleSweep.dispose()
    const initial = restTestSend('retained ordinary history', attached.fence)
    expect(await rig.host.send(REST_TEST_CALLER, initial)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
    const firstRequest = rig.adapter.dispatch.mock.calls[0]![0]
    const firstDispatch = await rig.adapter.dispatch.mock.results[0]!.value
    if (firstDispatch.state !== 'accepted' || firstDispatch.providerIdentity.provider !== 'codex') {
      throw new Error('the initial ordinary send was not accepted by Codex')
    }
    const provider = rig.adapter.acquire.mock.calls.at(-1)![0].events!
    const firstTurnIdentity = { ...firstDispatch.providerIdentity, ordinal: 0 }
    const firstTurn = {
      kind: 'turn' as const,
      turnId: firstDispatch.providerIdentity.turnId,
      userItemId: agentJournalSubmissionKey(firstRequest.clientMessageId),
      state: 'completed' as const,
      outcome: 'success' as const
    }
    provider.appendItem(firstTurnIdentity, firstTurn, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await rig.host.flushStreamedEvents(SESSION)
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const physicalEpoch = journal.physicalCursor().epoch
    await journal.write({
      kind: 'epoch-replace',
      reason: 'handle_forked',
      fence: attached.fence,
      items: [
        {
          identity: { provider: 'orca', clientMessageId: firstRequest.clientMessageId },
          body: initial.body,
          ownerFence: attached.fence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        {
          identity: firstTurnIdentity,
          body: firstTurn,
          ownerFence: attached.fence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ],
      providerHandle: undefined
    })
    await rig.host.flushStreamedEvents(SESSION)
    expect(journal.cursor().epoch).not.toBe(physicalEpoch)
    const events: AgentSessionTurnCompletionEvent[] = []
    rig.host.subscribeTurnCompletions({ id: 'attention', emit: (event) => events.push(event) })
    const next = restTestSend('finish after rewind', attached.fence)
    const nextReply = await rig.host.send(REST_TEST_CALLER, next)
    expect(nextReply).toMatchObject({ ok: true })
    expect(await journal.reads.submission(next.envelope.clientOperationId)).toBeDefined()
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    const request = rig.adapter.dispatch.mock.calls[1]![0]
    const dispatched = await rig.adapter.dispatch.mock.results[1]!.value
    if (dispatched.state !== 'accepted' || dispatched.providerIdentity.provider !== 'codex') {
      throw new Error('the ordinary send was not accepted by Codex')
    }
    const turn = { ...dispatched.providerIdentity, ordinal: 0 }
    const body = {
      kind: 'turn' as const,
      turnId: turn.turnId,
      userItemId: agentJournalSubmissionKey(request.clientMessageId)
    }
    provider.appendItem(
      turn,
      { ...body, state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await rig.host.flushStreamedEvents(SESSION)
    provider.appendItem(
      turn,
      { ...body, state: 'completed', outcome: 'success', completedAt: rig.clock.now },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await rig.host.flushStreamedEvents(SESSION)
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'completion')).toHaveLength(1)
    )
    const edge = events.find((event) => event.type === 'completion')!
    const origin = structuredAttentionOrigin(edge)
    if (!origin) {
      throw new Error('completion has no journal position')
    }
    expect(origin.journalCursor).toEqual(journal.cursor())
    const announcements = createAnnouncedNotificationRegistry()
    announcements.record('chat-pane', 'completed', origin)
    announcements.record('other-pane', 'other-scope', {
      ...origin,
      scope: { ...origin.scope, workspaceId: 'another-workspace' }
    })
    // The idle sweep keeps a chat whose delivery loop has not parked after the second send.
    await rig.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    await vi.waitFor(() => expect(rig.host.hasSession(SESSION)).toBe(false))
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
    const retiredCursor = journal.cursor()
    announcements.record('chat-pane', 'later-unread', {
      ...origin,
      journalCursor: { ...retiredCursor, sequence: retiredCursor.sequence + 1 }
    })
    const acquisitions = rig.adapter.acquire.mock.calls.length
    const reopen = vi.spyOn(journalFactory, 'openAgentSessionJournal')
    try {
      const reads = await rig.host.attentionReads.workspace(HOST_TEST_LOCATION)
      expect(
        announcements
          .takeAcknowledged({ worktree: HOST_TEST_LOCATION, reads })
          .map((entry) => entry.id)
      ).toEqual(['completed'])
      expect(announcements.hasAnnouncement({ notificationId: 'completed' })).toBe(false)
      expect(announcements.hasAnnouncement({ notificationId: 'later-unread' })).toBe(true)
      expect(announcements.hasAnnouncement({ notificationId: 'other-scope' })).toBe(true)
      expect(reads).toEqual([
        { sessionId: SESSION, scope: HOST_TEST_LOCATION, observedCursor: retiredCursor }
      ])
      expect(reopen).not.toHaveBeenCalled()
      expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
      expect(rig.host.loadedSessionIds()).toEqual([])
    } finally {
      reopen.mockRestore()
    }
  } finally {
    await rig.dispose()
  }
})
