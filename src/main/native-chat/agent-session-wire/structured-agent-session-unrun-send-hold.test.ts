import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

const words = (kind: 'hostRestarted' | 'chatClosed' | 'cancelled') =>
  agentSessionFailureWords(agentSessionFailureFact(kind), { surface: 'rejection' })
const KEPT = { state: 'waiting' }

function derivedPauses(): string[] {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  return structuredQueuePauses(journal).map((pause) => pause.reason)
}

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({
    restartable: true,
    starting: true,
    recoveryCapsule: true
  })
})

afterEach(async () => {
  await rig.dispose()
})

async function heldBehindHungStart(text: string): Promise<string> {
  await rig.host.close(SESSION, 'evict')
  const sent = rig.send(text)
  await sent.result
  await eventually(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )
  expect((await rig.submission(sent.id))?.handedOverAt).toBeUndefined()
  expect(rig.dispatch).not.toHaveBeenCalled()
  return sent.id
}

describe('a message held behind a start that never answered, then the chat ends', () => {
  it('is a card after a quit, rejected as a restart, held by the reopen until a turn', async () => {
    const id = await heldBehindHungStart('kept through quit')
    await rig.quitRestartHostProcess()

    expect(await rig.submission(id)).toMatchObject({
      dispatchState: 'rejected',
      ...words('hostRestarted'),
      keptAsQueuedMessageId: id
    })
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    const [card] =
      rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.queuedMessages.list() ?? []
    expect(card).toMatchObject({ holdReason: null })
    expect(derivedPauses()).toEqual(['restarted'])
    expect(await rig.restartOffers()).toEqual([])
  })

  it('is offered for resume after a quit once the start proved itself, as the control', async () => {
    await rig.dispose()
    rig = await createQueuedMessageTestRig({
      restartable: true,
      starting: true,
      recoveryCapsule: true
    })
    await rig.host.close(SESSION, 'evict')
    const sent = rig.send('may have run')
    await sent.result
    await rig.proveStart()
    await eventually(async () =>
      expect((await rig.submission(sent.id))?.handedOverAt).toBeDefined()
    )
    const id = sent.id
    await rig.quitRestartHostProcess()

    expect(await rig.restartOffers()).toEqual([
      { sessionId: SESSION, work: { kind: 'submission', id } }
    ])
  })

  it.each(['user-close', 'evict'] as const)(
    'is a card after a %s, rejected as closed, held by the reopen until a turn',
    async (cause) => {
      const id = await heldBehindHungStart('kept at close')
      await rig.host.close(SESSION, cause)
      rig.crashRestartHostProcess()

      expect(await rig.submission(id)).toMatchObject({
        dispatchState: 'rejected',
        ...words('chatClosed'),
        keptAsQueuedMessageId: id
      })
      expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
      expect(derivedPauses()).toEqual(['restarted'])
    }
  )

  it("is withdrawn by a person's Stop, as a queued one is, and kept as no card", async () => {
    const id = await heldBehindHungStart('stopped')

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    await eventually(async () =>
      expect(await rig.submission(id)).toMatchObject({
        dispatchState: 'rejected',
        ...words('cancelled')
      })
    )
    expect(await rig.drafts()).toEqual([])
  })
})
