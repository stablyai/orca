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
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
  hostTestMessage,
  hostTestLaunchDirectory
} from './structured-agent-session-host-test-data'

export const GRACE = 15_000

export async function interruptedRestart(
  work: 'turn' | 'submission' = 'turn',
  historyBoundaryConsistent = true
) {
  const previous = hostTestState()
  await attach()
  const events = previous.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  if (work === 'submission') {
    previous.dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const body = hostTestMessage('Perform the original task')
    await previous.host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
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
      ...(work === 'submission'
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
    resolveLaunchDirectory: hostTestLaunchDirectory,
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

/** A reattach that succeeds and a continuation the host refuses: the provider finished the turn
 *  while the continuation was being recorded, as the superseded-evidence cases above set up. */
/** `userAnswers` has the user reply in the chat just before or after its own attempt, while the
 *  rest of a batch would still be running. */
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
      { provider: 'codex', threadId: THREAD, turnId: 'interrupted-turn', ordinal: 1 },
      { kind: 'turn', turnId: 'interrupted-turn', state: 'completed' },
      { lifecycle: true }
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
