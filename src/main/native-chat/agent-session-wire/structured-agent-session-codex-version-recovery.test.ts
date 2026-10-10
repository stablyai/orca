import { afterEach, beforeEach, expect, it } from 'vitest'
import { CodexCliInstallationError } from '../../codex/codex-cli-installation-error'
import { codexMaintenanceRecoveryAction } from '../../../shared/codex-maintenance-recovery'
import { isStructuredAgentSessionStartFailureRow } from '../../../shared/structured-agent-session-start-failure-row-key'
import {
  projectQueuedMessageCards,
  queuedMessagesQueuePause
} from '../../../renderer/src/components/native-chat/structured-agent-session-queued-cards'
import { HOST_TEST_SESSION, hostTestMessage } from './structured-agent-session-host-test-data'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig({
    restartable: true,
    idleSweep: { idleMs: 0, intervalMs: 60 * 60 * 1000 }
  })
})
afterEach(() => rig.dispose())

async function recoveryAction() {
  const result = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  if (!result.ok) {
    throw new Error('History refused')
  }
  const { page } = result
  const cards = projectQueuedMessageCards(page.queuedMessages, page.submissions, {
    queuePaused: Boolean(page.queuePause)
  })
  const pause = queuedMessagesQueuePause(cards, page.queuePause ?? null)
  return {
    page,
    cards,
    action: codexMaintenanceRecoveryAction(false, cards, pause !== null)
  }
}

async function retainedDraft() {
  const working = await rig.workingSend()
  const queued = await rig.send('retained instruction', 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('Expected a queued draft')
  }
  await rig.stop()
  await rig.settleAccepted(working, 'earlier-turn')
  await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()
  rig.starts.mockImplementationOnce(() => {
    throw new CodexCliInstallationError({
      installedVersion: '0.135.0',
      minimumVersion: '0.136.0'
    })
  })
  return queued.value.queued.messageId
}

it.each(['returned', 'held'] as const)(
  'uses per-message Send after an existing conversation restart is version-refused with a %s draft and no pause',
  async (kind) => {
    let id = await retainedDraft()
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect((await rig.handoff(id))?.dispatchState).toBe('rejected'))
    const rejected = await rig.handoffId(id)
    if (kind === 'held') {
      await rig.deleteQueued(id)
      id = 'held-draft'
      const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
      if (!journal) {
        throw new Error('Missing journal')
      }
      await journal.queuedMessages.insert({
        messageId: id,
        body: hostTestMessage('retained instruction'),
        fingerprint: 'retained-instruction',
        hostInstance: structuredAgentSessionHostInstance(),
        holdReason: 'send_failed'
      })
    }
    const { page, cards, action } = await recoveryAction()
    expect(page.queuePause ?? null).toBeNull()
    expect(cards).toMatchObject([{ messageId: id, hold: kind === 'held' ? 'paused' : 'returned' }])
    expect(
      page.items.filter((item) => isStructuredAgentSessionStartFailureRow(item.itemId))
    ).toMatchObject([
      {
        body: {
          failure: { refusal: { details: { codexInstallation: { installedVersion: '0.135.0' } } } }
        }
      }
    ])
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: false } })
    const attempts = rig.starts.mock.calls.length
    expect((await rig.submission(rejected))?.handedOverAt).toBeUndefined()
    expect(rig.starts).toHaveBeenCalledTimes(attempts)
    expect(action).toEqual({ kind: 'message', messageId: id })
    if (action.kind !== 'message') {
      throw new Error('Expected per-message Send')
    }
    expect(await rig.sendNow(action.messageId)).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.handoff(id))?.handedOverAt).toBeDefined())
    expect(await rig.handoffId(id)).not.toBe(rejected)
    expect(rig.starts).toHaveBeenCalledTimes(attempts + 1)
    expect((await rig.submission(rejected))?.dispatchState).toBe('rejected')
  }
)

it('offers Resume only for an actual pause and releases it through the host', async () => {
  const id = await retainedDraft()
  rig.starts.mockReset()
  const { action } = await recoveryAction()
  expect(action.kind).toBe('queue')
  expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
  await eventually(async () => expect((await rig.handoff(id))?.handedOverAt).toBeDefined())
  expect(await rig.queuePause()).toBeNull()
})

it('has no recovery button when no draft or resumable pause remains', async () => {
  const id = await retainedDraft()
  expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
  await eventually(async () => expect((await rig.handoff(id))?.dispatchState).toBe('rejected'))
  await rig.deleteQueued(id)
  const { action } = await recoveryAction()
  expect(action.kind).toBe('send-again')
})
