import { describe, expect, it } from 'vitest'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import {
  acquire,
  eventually,
  heldBehindStart,
  host,
  proveOpen,
  publishFirst,
  restartWith,
  store,
  submission,
  registerStartupAttemptHostTests
} from './structured-agent-session-startup-attempt-host-test-support'

registerStartupAttemptHostTests()

describe('what a started child reports', () => {
  it('preserves a later accepted pick when an older child reports options', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await store.replaceSessionOptions({
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      options: { model: 'picked' },
      now: NOW
    })
    await proveOpen('reported')
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    await host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reportedOptions: { model: 'from-settings' }
    })
    await host.flushStreamedEvents(SESSION)
    expect(store.getRecord(SESSION)?.options).toEqual({ model: 'picked' })
  })
})
