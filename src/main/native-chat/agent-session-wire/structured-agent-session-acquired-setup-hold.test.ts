import { afterEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  restTestSend,
  REST_TEST_CALLER as CALLER,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  hostTestAttachParams,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import { stopCreatedChat } from './structured-agent-session-create-test-fixture'

let rig: RestTestRig
let release: (() => void) | undefined
afterEach(async () => {
  release?.()
  await rig.dispose()
})

it.each([false, true])(
  'keeps the original acquired receipt pending with a writable early chat; Stop=%s',
  async (stop) => {
    const setup = Promise.withResolvers<void>()
    release = () => setup.resolve()
    let held = true
    rig = await createRestTestRig({
      setupHold: () => (held ? setup.promise : null),
      idleSweep: { intervalMs: 60_000 }
    })
    const params = hostTestAttachParams(null)
    const published = Promise.withResolvers<void>()
    const publishTab = vi.fn(async () => {
      published.resolve()
    })
    let finished = false
    const original = rig.host
      .attach(CALLER, params, { publishTab })
      .then((result) => {
        finished = true
        return result
      })
      .catch((error: unknown) => error)
    await published.promise
    const operation = () =>
      rig.store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)
    expect(operation()?.outcome.status).toBe('pending')
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal).toBeDefined()
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    const replay = rig.host.attach(CALLER, params, { publishTab })
    const fence = rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const message = restTestSend('accepted during setup', fence)
    expect(await rig.host.send(CALLER, message)).toMatchObject({ ok: true })
    rig.clock.now += 45_000
    expect(finished).toBe(false)
    expect(rig.host.collaboratorsForTests().runtimeState.startupAttempts.isOpen(SESSION)).toBe(
      false
    )
    if (stop) {
      expect(await stopCreatedChat(rig.host, SESSION, fence)).toMatchObject({
        ok: true,
        value: { cancelled: true }
      })
      expect((await rig.host.journalSnapshot(SESSION)).submissions).toContainEqual(
        expect.objectContaining({
          clientMessageId: message.envelope.clientOperationId,
          dispatchState: 'rejected',
          rejection: { kind: 'cancelled', neverReachedAgent: true }
        })
      )
      expect(rig.adapter.acquire).not.toHaveBeenCalled()
    }
    held = false
    setup.resolve()
    const result = await original
    const replayed = await replay
    if (stop) {
      expect(result).toBeInstanceOf(Error)
    } else {
      expect(result).toMatchObject({ ok: true })
    }
    expect(replayed.ok).toBe(!stop)
    expect(operation()?.outcome.status).toBe(stop ? 'failed' : 'succeeded')
    if (stop) {
      expect(rig.adapter.acquire).not.toHaveBeenCalled()
      expect(rig.adapter.dispatch).not.toHaveBeenCalled()
    } else {
      expect(rig.adapter.acquire).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
      await rig.host.close(SESSION, 'evict')
      const rested = await rig.host.attach(CALLER, params)
      expect(rested).toMatchObject({ ok: true, replayed: true })
      expect(rig.adapter.acquire).toHaveBeenCalledOnce()
    }
  }
)
