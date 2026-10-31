import { expect, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { THREAD_ID as THREAD } from '../../codex/codex-structured-session-adapter-fixture'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexTurnLifecycleIdentity } from '../../codex/codex-structured-journal-translation-turns'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { createRootDispatch } from '../../runtime/orchestration/db/root-dispatch-test-fixture'
import { escalateChatWorkerError } from '../../runtime/orchestration/chat-worker-error-escalation'
import {
  structuredWorkerIdentities,
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey
} from '../../runtime/structured-worker-identity'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'

export type Rig = ReturnType<typeof codexInputFinalizationFixture>
export const journalOf = (rig: Rig) =>
  rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
export const key = (turnId: string) =>
  agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, turnId))
export const hidden = (rig: Rig) =>
  rig.starts().filter((call) => Array.isArray(call.params?.input) && call.params.input.length === 0)
export const flush = (rig: Rig) => rig.host.flushStreamedEvents(SESSION)
export async function root(rig: Rig, text = 'complete this real request') {
  await rig.began(await rig.permissionSend(text))
  return rig.turns.turnId!
}
export async function fail(rig: Rig) {
  rig.turns.end('failed', 'provider overloaded', 'serverOverloaded')
  await flush(rig)
}
export async function tail(rig: Rig, turnId: string, suffix: string) {
  rig.notify('item/completed', {
    threadId: THREAD,
    turnId,
    item: { type: 'agentMessage', id: `late-${turnId}-${suffix}`, text: 'late output' }
  })
  await flush(rig)
}
export function accounting(rig: Rig) {
  return rig.host['clientDelivery'].requestFailures
}
export function assertRetired(rig: Rig) {
  expect(rig.host['providerRetry']['retries'].size).toBe(0)
  expect(accounting(rig)['baselines'].get(SESSION)?.deferred).toBeUndefined()
}
export function assertNoOrdinaryWork(rig: Rig) {
  const sessions = rig.host.collaboratorsForTests().sessions
  const journal = journalOf(rig)
  const work = hostStructuredAgentSessionCurrentWork(
    { store: rig.host.deps.store, sessions },
    SESSION
  )!
  expect(work.activeTurnId()).toBeNull()
  expect(work.owesAnySend()).toBe(false)
  expect(structuredAgentSessionHandingOver(journal).size).toBe(0)
  expect(sessions.get(SESSION)?.child?.heldSends?.()).toEqual(new Set())
  for (const submission of journal.submissions()) {
    expect(work.owesSend(submission)).toBe(false)
    expect(continuingStructuredAgentSessionInput(journal, submission.clientMessageId)).toBe(false)
    expect(finalizingStructuredAgentSessionInput(journal, submission.clientMessageId)).toBe(false)
  }
}
export async function withEscalation(
  rig: Rig,
  runTest: (
    mail: () => ReturnType<OrchestrationDb['getUnreadRunMailbox']>,
    drain: () => Promise<void>,
    complete: () => void,
    notify: Mock<(handle: string, messageType: string) => void>,
    reassign: () => ReturnType<typeof createRootDispatch>
  ) => Promise<void>
) {
  const db = new OrchestrationDb(':memory:')
  const worker = structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId: SESSION,
    agent: 'codex',
    paneKey: mintStructuredWorkerPaneKey(SESSION),
    processIncarnation: `structured:${SESSION}`,
    worktreeId: 'workspace-1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  const run = db.createRun({
    objective: 'completion accounting',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
  })
  const dispatch = createRootDispatch(
    db,
    db.createTask({ spec: 'work', runId: run.id }).id,
    worker.handle,
    worker.paneKey
  )
  const previous = rig.host.deps.onRequestFailure
  const pending: Promise<void>[] = []
  const notify = vi.fn<(handle: string, messageType: string) => void>()
  rig.host.deps.onRequestFailure = (failure) => {
    previous?.(failure)
    pending.push(
      escalateChatWorkerError(failure, { getDb: () => db, isWaitingForMail: () => false, notify })
    )
  }
  try {
    await runTest(
      () => db.getUnreadRunMailbox(run.id, 100, ['escalation']),
      async () => {
        await Promise.all(pending)
      },
      () => db.completeDispatch(dispatch.id),
      notify,
      () => {
        db.completeDispatch(dispatch.id)
        return createRootDispatch(
          db,
          db.createTask({ spec: 'replacement work', runId: run.id }).id,
          worker.handle,
          worker.paneKey
        )
      }
    )
  } finally {
    rig.host.deps.onRequestFailure = previous
    try {
      await Promise.all(pending)
    } finally {
      structuredWorkerIdentities.forget(worker.handle)
      db.close()
    }
  }
}
