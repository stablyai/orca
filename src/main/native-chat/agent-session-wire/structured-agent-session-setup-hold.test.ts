// A chat in a workspace whose project waits for setup takes its message at once; its agent starts
// once setup lets it go, and a Stop meanwhile ends that pending start like any other.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  try {
    await rig.dispose()
  } finally {
    vi.useRealTimers()
  }
})

/** A chat whose agent is not running, in a workspace whose setup is still running. */
async function chatHeldBySetup(): Promise<PromiseWithResolvers<void>> {
  const setup = Promise.withResolvers<void>()
  let running = false
  void setup.promise.then(() => {
    running = false
  })
  rig = await createQueuedMessageTestRig({
    restartable: true,
    setupHold: () => (running ? setup.promise : null)
  })
  running = true
  await rig.host.close(SESSION, 'evict')
  rig.starts.mockClear()
  return setup
}

function runtimeState() {
  return rig.host.collaboratorsForTests().runtimeState
}

it('accepts the first message at once and starts the agent only once setup ends', async () => {
  const setup = await chatHeldBySetup()
  const first = rig.send('hello')

  expect(await first.result).toMatchObject({ ok: true })
  await vi.advanceTimersByTimeAsync(50)
  expect(rig.starts).not.toHaveBeenCalled()
  // Setup time is not counted against the agent's startup clock.
  expect(runtimeState().startupAttempts.isOpen(SESSION)).toBe(false)

  setup.resolve()
  await eventually(async () => {
    if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase === 'starting') {
      await rig.proveStart()
    }
    expect((await rig.submission(first.id))?.handedOverAt).toBeDefined()
  })
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
})

it('cancels the pending start when Stop arrives while setup runs', async () => {
  const setup = await chatHeldBySetup()
  const first = rig.send('hello')
  await first.result
  await eventually(() => expect(runtimeState().startFlights.has(SESSION)).toBe(true))

  expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(await rig.submission(first.id)).toMatchObject({ rejection: { kind: 'cancelled' } })
  await eventually(() => expect(runtimeState().startFlights.has(SESSION)).toBe(false))

  setup.resolve()
  await vi.advanceTimersByTimeAsync(50)
  expect(rig.starts).not.toHaveBeenCalled()
  expect(rig.dispatch).not.toHaveBeenCalled()
})
