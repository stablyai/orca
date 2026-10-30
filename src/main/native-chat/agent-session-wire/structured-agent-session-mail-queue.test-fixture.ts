import { MailPointerRepointScheduler } from '../../runtime/orchestration/mail-pointer-repoint-scheduler'
import { afterEach, beforeEach, expect } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  ordinaryMailCreationId
} from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { captureSessionMailAtStop } from '../../runtime/orchestration/session-mail-stop-inventory'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'
export let rig: QueuedMessageTestRig
export let db: OrchestrationDb
export let bridge: OrchestrationStructuredMailboxPointerDelivery<never>
const retry = new MailPointerRepointScheduler((mailbox) => bridge.retryForHandle(mailbox))
export const clock = createStructuredSessionObservationClock(() => rig.host, SESSION)
export function installMailQueueLifecycle() {
  beforeEach(async () => {
    clock.start()
    rig = await createQueuedMessageTestRig({ restartable: true })
    db = new OrchestrationDb(':memory:')
    setStructuredAgentSessionHost(rig.host)
    bridge = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: (address) =>
        address === 'consumer' ? { sessionId: SESSION, dispatchId: null } : null,
      getCliCommand: () => 'orca',
      senderName: () => null,
      host: createStructuredMailboxPointerHost(),
      scheduleRetry: (mailbox) => retry.schedule(mailbox),
      cancelRetry: (mailbox) => retry.cancel(mailbox)
    })
    installSourceCapture()
  })
  afterEach(async () => {
    setStructuredAgentSessionHost(null)
    bridge.resetForDatabaseChange()
    retry.clear()
    await clock.restoreBeforeCleanup(async () => {
      await rig.dispose()
      db.close()
    })
  })
}
export function installSourceCapture() {
  rig.host.deps.captureSessionMail = () =>
    captureSessionMailAtStop(db, () => {
      throw new Error('source retirement')
    })
}
export function journal() {
  const value = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!value) {
    throw new Error('journal missing')
  }
  return value
}
export async function report(subject: string, notify = true) {
  const row = db.insertMessage({ from: 'worker', to: 'consumer', subject })
  if (notify) {
    bridge.deliverForHandle('consumer')
  }
  return row
}
export async function card(messageId: string) {
  const message = db.getMessageById(messageId)
  if (!message) {
    throw new Error('source missing')
  }
  const id = ordinaryMailCreationId(message)
  await eventually(() => {
    expect(db.getMessageById(messageId)?.delivered_at, message.subject).not.toBeNull()
    expect(journal().queuedMessages.get(id)).toBeTruthy()
  })
  return id
}

export async function complete(id: string) {
  await rig.settleAccepted(id, id)
  await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: `full-${id}`, ordinal: 0 },
    {
      kind: 'turn',
      turnId: `full-${id}`,
      state: 'completed',
      outcome: 'success',
      startedAt: Date.now(),
      completedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(id)
    },
    {
      fence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

export function openMailQueueSource(path: string) {
  db = new OrchestrationDb(path)
  installSourceCapture()
}

/** Count the actual disposable owner, separately from durable rows and ordinary queue state. */
export function mailWorkCounts() {
  const work = Reflect.get(bridge, 'work')
  const boxes = Reflect.get(work, 'mailboxes')
  const scopes = Reflect.get(work, 'scopes')
  const attempts = Reflect.get(work, 'attempts')
  const interests = Reflect.get(bridge, 'interests')
  if (
    !(
      boxes instanceof Map &&
      scopes instanceof Map &&
      attempts instanceof Map &&
      interests instanceof Map
    )
  ) {
    throw new Error('mail owner instrumentation changed')
  }
  return {
    containers: boxes.size,
    pendingIds: [...boxes.values()].reduce((n, ids) => n + ids.size, 0),
    reverseIds: scopes.size,
    reverseMemberships: [...scopes.values()].reduce((n, ids) => n + ids.size, 0),
    attempts: attempts.size,
    interests: interests.size,
    deferred: [...interests.values()].reduce((n, interest) => n + interest.deferred.size, 0),
    timers: retry.pendingCount
  }
}
