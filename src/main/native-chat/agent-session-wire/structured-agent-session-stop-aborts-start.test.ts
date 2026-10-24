import { afterEach, expect, it, vi } from 'vitest'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { JournalStopAcceptor } from '../agent-session-journal/journal-stop-acceptance'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => {
  vi.restoreAllMocks()
  rig.dispose()
})

async function duringStart(during: () => void): Promise<void> {
  rig = await createQueuedMessageTestRig({ restartable: true })
  await rig.host.close(SESSION, 'evict')
  const runtimeState = rig.host.collaboratorsForTests().runtimeState
  const probe = runtimeState.probeOwner.bind(runtimeState)
  let ran = false
  runtimeState.probeOwner = async (sessionId) => {
    if (!ran) {
      ran = true
      during()
    }
    return probe(sessionId)
  }
}

async function untilHandedOver(id: string): Promise<void> {
  await eventually(async () => {
    if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase === 'starting') {
      await rig.proveStart()
    }
    expect((await rig.submission(id))?.handedOverAt).toBeDefined()
  })
}

it('starts a Codex chat afresh for a message sent right after a Stop reached its reconciling start', async () => {
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  let second: ReturnType<QueuedMessageTestRig['send']> | undefined
  await duringStart(() => {
    stopping = rig.stop()
    second = rig.send('second')
  })
  const first = rig.send('hello')
  await first.result
  await eventually(() => expect(second).toBeDefined())
  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  await second!.result
  await untilHandedOver(second!.id)
  expect(await rig.submission(first.id)).toMatchObject({ rejection: { kind: 'cancelled' } })
  expect((await rig.submission(second!.id))?.rejection).toBeUndefined()
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
})

it('answers truthfully when the save is slow and an option pick waits behind it', async () => {
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  const saving = Promise.withResolvers<void>()
  const accept = JournalStopAcceptor.prototype.accept
  vi.spyOn(JournalStopAcceptor.prototype, 'accept').mockImplementation(async function (
    this: JournalStopAcceptor,
    ...args
  ) {
    await saving.promise
    return accept.apply(this, args)
  })
  await duringStart(() => {
    stopping = rig.stop()
  })
  const first = rig.send('hello')
  await first.result
  await eventually(() => expect(stopping).toBeDefined())
  const fields = { key: 'model', value: 'gpt-next' }
  const picked = rig.host.setOption(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
    ...fields
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  saving.resolve()

  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child ?? null).toBeNull()
  expect(rig.dispatch).not.toHaveBeenCalled()
  expect(await rig.submission(first.id)).toMatchObject({ rejection: { kind: 'cancelled' } })
  const pick = await picked
  expect(JSON.stringify(pick)).not.toContain('stopped while starting')
  expect(pick).toMatchObject({ ok: true })
})

it('answers that it stopped the queued message even when its write throws after the commit', async () => {
  let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
  const accept = JournalStopAcceptor.prototype.accept
  vi.spyOn(JournalStopAcceptor.prototype, 'accept').mockImplementationOnce(async function (
    this: JournalStopAcceptor,
    ...args
  ) {
    await accept.apply(this, args)
    throw new Error('fold failed after commit')
  })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await duringStart(() => {
    stopping = rig.stop()
  })
  const first = rig.send('hello')
  await first.result
  await eventually(() => expect(stopping).toBeDefined())

  expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(await rig.submission(first.id)).toMatchObject({ rejection: { kind: 'cancelled' } })
})

it.each(['before the call', 'while the agent prepares it'] as const)(
  'returns a queued card to waiting when the Stop lands %s',
  async (when) => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const working = await rig.workingSend()
    const queued = await rig.send('queued behind the turn', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const card = queued.value.queued.messageId
    let stopping: ReturnType<QueuedMessageTestRig['stop']> | undefined
    if (when === 'before the call') {
      const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const resolve = journal.resolveDispatch.bind(journal)
      vi.spyOn(journal, 'resolveDispatch').mockImplementation(async (input) => {
        const written = await resolve(input)
        if (input.state === 'pending' && input.clientMessageId !== working && !stopping) {
          stopping = rig.stop()
        }
        return written
      })
    } else {
      rig.dispatch.mockImplementationOnce(async (input) => {
        stopping = rig.stop()
        return waitForPromiseWithSignal(new Promise<never>(() => {}), input.signal)
      })
    }
    await rig.settleAccepted(working, 'working')

    await eventually(() => expect(stopping).toBeDefined())
    expect(await stopping).toMatchObject({ ok: true })
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: card, state: 'waiting' }])
    )
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(rig.dispatch).toHaveBeenCalledTimes(when === 'before the call' ? 1 : 2)
  }
)
