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
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { StructuredAgentSessionResumeAdmission } from './structured-agent-session-restart-resume-runner'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'

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
  historyBoundaryConsistent = true
) {
  const previous = hostTestState()
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
    // Accepted first, handed over after: the work in flight is a send the provider took.
    await vi.waitFor(() => expect(previous.dispatch).toHaveBeenCalledOnce())
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
    previous.host.deps.adapter.backgroundTaskState = () => ({
      state: 'monitoring',
      tasks: [{ id: 'child-1', kind: 'agent', description: 'Review loop 4', state: 'working' }]
    })
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

export async function statusNotes(host: StructuredAgentSessionHost) {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [{ text: item.body.text, tone: item.body.tone }] : []
  )
}

/** A reattach that succeeds and a continuation the host refuses: a message from another client
 *  lands while the continuation is being recorded. `userAnswers` has the user reply in the chat
 *  just before or after its own attempt, while the rest of a batch would still be running. */
export async function supersededRefusal(userAnswers?: 'before' | 'after') {
  const { host, store, acquire, dispatch, root } = await interruptedRestart()
  await host.restartResume.list()
  // Started ahead of the continuation, so a newer message can land from the provider.
  await startAgent({ host, store })
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing resumed provider event sink')
  }
  // The newer message lands after the reattach and just before the continuation is accepted,
  // which is where a send asks whether its offer still stands.
  const send = host.send
  const writing = vi.spyOn(host, 'send')
  writing.mockImplementationOnce(async (caller, params) => {
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'newer-turn', ordinal: 1 },
      hostTestMessage('A newer task from another client')
    )
    await host.flushStreamedEvents(SESSION)
    return send(caller, params)
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
