import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'

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
import * as reducer from '../agent-session-journal/journal-reducer'
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

export const QUEUED_BEFORE_QUIT = ['card A', 'card B'] as const

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
  work: 'turn' | 'submission' | 'send-after-reply' | 'children' | 'queued-cards' = 'turn',
  /** What the restarted host proves about the recorded owner; gone unless a test says otherwise. */
  probeOwner: NonNullable<StructuredAgentSessionHostDeps['probeOwner']> = async () => ({
    outcome: 'pid-absent'
  }),
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
    // Prior exchange ended; the next send has no turn yet.
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
    // Match adapter close: settle child work once its transport is gone.
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
  if (work === 'queued-cards') {
    for (const text of QUEUED_BEFORE_QUIT) {
      const body = hostTestMessage(text)
      const fields = { body, delivery: 'queue-if-active' as const }
      const queued = await previous.host.send(CALLER, {
        envelope: envelope('agentSession.send', fields),
        ...fields
      })
      expect(queued).toMatchObject({ ok: true, value: { queued: expect.anything() } })
    }
  }
  await previous.host.flushAllStreamedEvents()
  const store = await openTestAgentSessionRecordStore(previous.root)
  const closeSession = vi.fn(async () => true)
  const clock = { now: NOW + 1 }
  const log = recordingProductionStructuredAgentSessionLogger()
  const host = new StructuredAgentSessionHost({
    agents,
    logger: log.logger,
    store,
    adapter: { ...adapter(), closeSession },
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

/** Commit/fold the only upcoming continuation submission, then throw to exercise replay. */
export function throwAfterContinuationAccepted(): void {
  const append = AgentSessionJournal.prototype.appendSubmission
  vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockImplementation(async function (
    this: AgentSessionJournal,
    ...args: Parameters<AgentSessionJournal['appendSubmission']>
  ) {
    await append.apply(this, args)
    throw new Error('the accepted continuation could not be answered')
  })
}

/** Fail folding after continuation commit to model uncertain readback; install immediately before sending. */
export function continuationCannotFold(): void {
  const fold = reducer.applyJournalRow
  vi.spyOn(reducer, 'applyJournalRow').mockImplementation((state, row) => {
    if (row.kind !== 'submission') {
      fold(state, row)
      return
    }
    // Advance sequence/fence before failure, matching reducer ordering.
    state.lastSequence = Math.max(state.lastSequence, row.seq)
    state.highestFence = Math.max(state.highestFence, row.fence)
    throw new Error('the accepted continuation could not fold')
  })
}

export async function statusNotes(host: StructuredAgentSessionHost) {
  return notesOf((await host.journalSnapshot(SESSION)).items)
}

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

export const QUIT_CUT_NOTICE = {
  text: 'Codex stopped while this response was in progress. You can continue in this conversation.',
  tone: 'error'
}

/** Inject acceptance after reservation so the user wins; userAnswers moves the send outside the attempt. */
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
