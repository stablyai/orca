import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
// A chat interrupted mid-turn by a restart, rebuilt on a fresh host over the same store, for the
// restart-resume ownership and failure tests.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE
} from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { parseAgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { StructuredAgentSessionResumeAdmission } from './structured-agent-session-restart-resume-runner'
import { childRecord } from './structured-agent-session-restart-resume-test-harness'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState,
  serveHostTestChildWork
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { recordingProductionStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import type { StructuredAgentRegistry } from './structured-agent-registry'

/** Starts the agent explicitly — the attach a client's ensure makes — for a test that needs a
 *  running child before its next step. Nothing else starts one ahead of a send. */
export async function startAgent(state: {
  host: StructuredAgentSessionHost
  store: AgentSessionRecordStore
}): Promise<void> {
  const result = await state.host.attach(
    CALLER,
    hostTestAttachParams(state.store.getRecord(SESSION)?.lease.runtimeFence ?? null)
  )
  expect(result.ok).toBe(true)
}

export async function interruptedRestart(
  work: 'turn' | 'submission' | 'send-after-reply' | 'children' = 'turn',
  historyBoundaryConsistent = true,
  /** What the restarted host proves about the recorded owner; gone unless a test says otherwise. */
  probeOwner: NonNullable<StructuredAgentSessionHostDeps['probeOwner']> = async () => ({
    outcome: 'pid-absent'
  }),
  /** What the relaunched host registers; restart actions scope by it. */
  agents: StructuredAgentRegistry = claudeAndCodexDeclared()
) {
  const previous = hostTestState()
  let children: AgentChildWorkView[] = []
  if (work === 'children') {
    serveHostTestChildWork(() => children)
  }
  await attach()
  const events = previous.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  if (work === 'send-after-reply') {
    // An earlier exchange had finished; the user's next send had not opened a turn yet.
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'earlier-turn', ordinal: 1 },
      { kind: 'turn', turnId: 'earlier-turn', state: 'completed' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await previous.host.flushStreamedEvents(SESSION)
  }
  if (work === 'submission' || work === 'send-after-reply') {
    previous.dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const body = hostTestMessage('Perform the original task')
    await previous.host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    // Accepted first, handed over after: the work in flight is a send the provider took.
    await vi.waitFor(() => expect(previous.dispatch).toHaveBeenCalledOnce())
  } else if (work === 'children') {
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'settled-turn', ordinal: 1 },
      { kind: 'turn', turnId: 'settled-turn', state: 'completed' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const group = {
      provider: 'codex',
      threadId: THREAD,
      turnId: 'settled-turn',
      ordinal: 2
    } as const
    const roster = (state: 'working' | 'unverifiable') => ({
      kind: 'message' as const,
      role: 'system' as const,
      blocks: [
        {
          type: 'subagent-group' as const,
          groupId: 'settled-turn',
          agents: [{ id: 'child-1', label: 'Review loop 4', state }]
        }
      ]
    })
    events.appendItem(group, roster('working'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    children = [childRecord({ id: 'child-1', kind: 'agent', description: 'Review loop 4' })]
    // As the real adapters do: the child's own close settles the children it can no longer hear.
    previous.host.deps.adapter.closeSession = async () => {
      events.appendItem(group, roster('unverifiable'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
      return true
    }
  } else {
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'interrupted-turn', ordinal: 1 },
      { kind: 'turn', turnId: 'interrupted-turn', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await previous.host.flushStreamedEvents(SESSION)
  await previous.host.flushAllStreamedEvents()
  const store = await openTestAgentSessionRecordStore(previous.root)
  const closeSession = vi.fn(async () => true)
  // The relaunch comes after the quit that recorded the offer.
  const clock = { now: NOW + 1 }
  const log = recordingProductionStructuredAgentSessionLogger()
  const host = new StructuredAgentSessionHost({
    agents,
    logger: log.logger,
    store,
    adapter: {
      ...adapter(),
      closeSession,
      ...(work === 'submission' || work === 'send-after-reply'
        ? {
            providerHistoryWindow: async () => ({
              items: [],
              boundaryConsistent: historyBoundaryConsistent,
              turnInFlight: false
            })
          }
        : {})
    },
    journalDatabase: openTestJournalHostDatabase(previous.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    probeOwner,
    recoveryCapsule: new AgentSessionRecoveryCapsule(previous.root),
    now: () => clock.now
  })
  replaceHostTestState({ store, host })
  previous.acquire.mockClear()
  previous.releaseAcquisition.mockClear()
  previous.dispatch.mockClear()
  const capsule = JSON.parse(
    await readFile(join(previous.root, AGENT_SESSION_RECOVERY_CAPSULE_FILE), 'utf8')
  )
  const marker = parseAgentSessionResumeMarker(capsule.entries[0]?.marker)
  return { ...hostTestState(), host, store, log, closeSession, marker, clock }
}

/** The continuation's submission commits, then its send throws: a send Orca may have taken. */
export function throwAfterContinuationAccepted(): void {
  const append = AgentSessionJournal.prototype.appendSubmission
  vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockImplementation(async function (
    this: AgentSessionJournal,
    ...args: Parameters<AgentSessionJournal['appendSubmission']>
  ) {
    const cursor = await append.apply(this, args)
    if (args[0].origin === 'host') {
      throw new Error('the accepted continuation could not be answered')
    }
    return cursor
  })
}

export async function statusNotes(host: StructuredAgentSessionHost) {
  return notesOf((await host.journalSnapshot(SESSION)).items)
}

/** The notes a reader's transcript shows, the cut turn's derived notice included. */
export async function readerNotes(host: StructuredAgentSessionHost) {
  return notesOf(
    withNativeChatCutTurnNotices((await host.journalSnapshot(SESSION)).items, {
      agentName: 'Codex'
    })
  )
}

function notesOf(items: readonly AgentJournalRenderItem[]) {
  return items.flatMap((item) =>
    item.body.kind === 'status' ? [{ text: item.body.text, tone: item.body.tone }] : []
  )
}

/** The one row the quit's cut turn reads with when nothing else explains it. */
export const QUIT_CUT_NOTICE = {
  text: 'Codex stopped while this response was in progress. You can continue in this conversation.',
  tone: 'error'
}

/** A continuation the host refuses because the user's own message was accepted first: another
 *  client's send lands after the action reserved the offer, just before the continuation is
 *  accepted. `userAnswers` instead has the user send before or after the whole attempt. */
export async function supersededRefusal(userAnswers?: 'before' | 'after') {
  const { host, store, acquire, dispatch, root } = await interruptedRestart()
  await host.restartResume.list()
  const body = hostTestMessage('A newer task from another client')
  const answer = () =>
    host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  const send = host.send
  const writing = vi.spyOn(host, 'send')
  if (!userAnswers) {
    writing.mockImplementationOnce(async (caller, params) => {
      await answer()
      return send(caller, params)
    })
  }
  const admit = StructuredAgentSessionResumeAdmission.prototype.run
  const admitting = vi.spyOn(StructuredAgentSessionResumeAdmission.prototype, 'run')
  if (userAnswers) {
    admitting.mockImplementationOnce(async function (this, ...args) {
      await (userAnswers === 'before' ? answer() : null)
      try {
        return await admit.apply(this, args)
      } finally {
        await (userAnswers === 'after' ? answer() : null)
      }
    })
  }
  try {
    const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
    return { host, store, acquire, dispatch, root, result }
  } finally {
    writing.mockRestore()
    admitting.mockRestore()
  }
}
