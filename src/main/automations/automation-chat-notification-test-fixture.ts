import { afterEach, expect, vi } from 'vitest'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { createStructuredAttentionMobileDelivery } from '../runtime/structured-agent-session-mobile-attention'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  HOST_TEST_NOW as NOW,
  hostTestOperationId,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'

const rigs: QueuedMessageTestRig[] = []
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  vi.restoreAllMocks()
})

export async function setup(agent?: 'claude') {
  const rig = await createQueuedMessageTestRig({ ...(agent ? { agent } : {}), restartable: true })
  rigs.push(rig)
  return rig
}

export function listen(rig: QueuedMessageTestRig, subscribers = 3) {
  const events: AgentSessionTurnCompletionEvent[][] = Array.from({ length: subscribers }, () => [])
  const phone = vi.fn()
  const delivery = createStructuredAttentionMobileDelivery({
    readNotificationSettings: () => ({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 1,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: true
    }),
    readWorkspaceLabels: () => ({}),
    isWorkspaceMuted: () => false,
    dispatch: phone,
    reconcile: () => {},
    now: () => NOW
  })
  const releases = events.map((edges, index) =>
    rig.host.subscribeTurnCompletions({
      id: `consumer-${index}`,
      includePrompts: true,
      emit: (event) => edges.push(event)
    })
  )
  releases.push(
    rig.host.subscribeTurnCompletions({
      id: 'phone',
      includePrompts: true,
      emit: (event) => {
        if (event.type !== 'end') {
          delivery.deliver(event, undefined)
        }
      }
    })
  )
  return { events, phone, stop: () => releases.forEach((release) => release()) }
}

export async function complete(rig: QueuedMessageTestRig, message: string, turnId: string) {
  await eventually(async () => {
    if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase === 'starting') {
      await rig.proveStart()
    }
    expect(
      rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.submission(message)
        ?.handedOverAt
    ).toBeDefined()
  })
  await rig.settleAccepted(message, turnId)
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const accepted = journal.submission(message)!
  const sink = rig.providerEvents()
  const identity = { provider: 'codex' as const, threadId: THREAD, turnId, ordinal: 1 }
  sink.appendItem(
    identity,
    {
      kind: 'turn',
      turnId,
      userItemId: accepted.providerItemId,
      state: 'completed',
      outcome: 'success'
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
  )
  sink.publish({ lifecycle: true })
  expect(await sink.written?.()).toEqual({ ok: true })
  await rig.host.flushStreamedEvents(SESSION)
  return agentJournalItemKey(identity)
}

export async function ownedSend(rig: QueuedMessageTestRig, runId: string, queued = false) {
  const id = hostTestOperationId()
  rig.host.registerAutomationChatRun(runId, SESSION, id)
  const fields = {
    body: hostTestMessage('automation'),
    ...(queued ? { delivery: 'queue-if-active' as const } : {})
  }
  expect(
    await rig.host.send(
      { callerKey: 'client-1' },
      {
        ...fields,
        envelope: rig.envelope(fields, 'agentSession.send', id)
      }
    )
  ).toMatchObject({ ok: true })
  return id
}
