// A chat interrupted mid-turn by a restart, rebuilt on a fresh host over the same store, for the
// restart-resume ownership and failure tests.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE
} from '../../runtime/agent-session-recovery-capsule'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { parseAgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
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
  hostTestMessage
} from './structured-agent-session-host-test-data'

export const GRACE = 15_000

export async function interruptedRestart(
  work: 'turn' | 'submission' | 'send-after-reply' | 'children' = 'turn',
  historyBoundaryConsistent = true
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
      { kind: 'turn', turnId: 'earlier-turn', state: 'completed' }
    )
    await previous.host.flushStreamedEvents(SESSION)
  }
  if (work === 'submission' || work === 'send-after-reply') {
    previous.dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const body = hostTestMessage('Perform the original task')
    await previous.host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  } else if (work === 'children') {
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'settled-turn', ordinal: 1 },
      { kind: 'turn', turnId: 'settled-turn', state: 'completed' }
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
    events.appendItem(group, roster('working'))
    children = [childRecord({ id: 'child-1', kind: 'agent', description: 'Review loop 4' })]
    // As the real adapters do: the child's own close settles the children it can no longer hear.
    previous.host.deps.adapter.closeSession = async () => {
      events.appendItem(group, roster('unverifiable'))
      return true
    }
  } else {
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'interrupted-turn', ordinal: 1 },
      { kind: 'turn', turnId: 'interrupted-turn', state: 'running' }
    )
  }
  await previous.host.flushStreamedEvents(SESSION)
  await previous.host.flushAllStreamedEvents()
  const store = await AgentSessionRecordStore.open({
    directory: join(previous.root, 'store'),
    hostId: 'local'
  })
  const closeSession = vi.fn(async () => true)
  const host = new StructuredAgentSessionHost({
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
    journalRoot: previous.root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    recoveryCapsule: new AgentSessionRecoveryCapsule(previous.root),
    releaseGraceMs: GRACE,
    now: () => NOW
  })
  replaceHostTestState({ store, host })
  previous.acquire.mockClear()
  previous.releaseAcquisition.mockClear()
  previous.dispatch.mockClear()
  const capsule = JSON.parse(
    await readFile(join(previous.root, AGENT_SESSION_RECOVERY_CAPSULE_FILE), 'utf8')
  )
  const marker = parseAgentSessionResumeMarker(capsule.entries[0]?.marker)
  return { ...hostTestState(), host, store, closeSession, marker }
}

export function statusNotes(host: StructuredAgentSessionHost) {
  return host
    .journalSnapshot(SESSION)
    .items.flatMap((item) =>
      item.body.kind === 'status' ? [{ text: item.body.text, tone: item.body.tone }] : []
    )
}

/** A reattach that succeeds and a continuation the host refuses: a message from another client
 *  lands while the continuation is being recorded. `userAnswers` has the user reply in the chat
 *  just before or after its own attempt, while the rest of a batch would still be running. */
export async function supersededRefusal(userAnswers?: 'before' | 'after') {
  const { host, acquire, dispatch, root } = await interruptedRestart()
  await host.restartResume.list()
  await host.hold(SESSION, 'pane')
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing resumed provider event sink')
  }
  const append = AgentSessionJournal.prototype.appendSubmission
  const writing = vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission')
  writing.mockImplementationOnce(async function (this: AgentSessionJournal, input) {
    const cursor = await append.call(this, input)
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'newer-turn', ordinal: 1 },
      hostTestMessage('A newer task from another client')
    )
    return cursor
  })
  const admit = StructuredAgentSessionResumeAdmission.prototype.run
  const admitting = vi.spyOn(StructuredAgentSessionResumeAdmission.prototype, 'run')
  const body = hostTestMessage('Carry on from where you stopped')
  const answer = () =>
    host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
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
    expect(result.continued).toMatchObject([{ outcome: 'refused' }])
    expect(dispatch).toHaveBeenCalledTimes(userAnswers ? 1 : 0)
    return { host, root, result }
  } finally {
    writing.mockRestore()
    admitting.mockRestore()
  }
}
