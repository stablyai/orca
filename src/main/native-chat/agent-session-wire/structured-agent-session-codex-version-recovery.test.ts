import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentCliInstallationError } from '../agent-cli-installation-error'
import { isStructuredAgentSessionStartFailureRow } from '../../../shared/structured-agent-session-start-failure-row-key'
import { projectQueuedMessageCards } from '../../../renderer/src/components/native-chat/structured-agent-session-queued-cards'
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

async function retainedCards() {
  const result = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  if (!result.ok) {
    throw new Error('History refused')
  }
  const { page } = result
  const cards = projectQueuedMessageCards(page.queuedMessages, page.submissions, {
    queuePaused: Boolean(page.queuePause)
  })
  return { page, cards }
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
    throw new AgentCliInstallationError({
      agent: 'codex',
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
    const { page, cards } = await retainedCards()
    expect(page.queuePause ?? null).toBeNull()
    expect(cards).toMatchObject([{ messageId: id, hold: kind === 'held' ? 'paused' : 'returned' }])
    expect(
      page.items.filter((item) => isStructuredAgentSessionStartFailureRow(item.itemId))
    ).toMatchObject([
      {
        body: {
          text: 'Codex 0.135.0 is too old for chats. Update to 0.136.0 or newer.',
          tone: 'error',
          failure: { refusal: { details: { codexInstallation: { installedVersion: '0.135.0' } } } }
        }
      }
    ])
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: false } })
    const attempts = rig.starts.mock.calls.length
    expect((await rig.submission(rejected))?.handedOverAt).toBeUndefined()
    expect(rig.starts).toHaveBeenCalledTimes(attempts)
    expect(await rig.sendNow(id)).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.handoff(id))?.handedOverAt).toBeDefined())
    expect(await rig.handoffId(id)).not.toBe(rejected)
    expect(rig.starts).toHaveBeenCalledTimes(attempts + 1)
    expect((await rig.submission(rejected))?.dispatchState).toBe('rejected')
  }
)

it('keeps an actual pause after a version refusal and releases it through the host', async () => {
  const id = await retainedDraft()
  rig.starts.mockReset()
  expect(await rig.queuePause()).not.toBeNull()
  expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
  await eventually(async () => expect((await rig.handoff(id))?.handedOverAt).toBeDefined())
  expect(await rig.queuePause()).toBeNull()
})
