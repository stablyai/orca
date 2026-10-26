import { describe, expect, it } from 'vitest'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import {
  acquire,
  dispatch,
  eventually,
  heldBehindStart,
  host,
  proveOpen,
  publishFirst,
  recordLiveListing,
  restartWith,
  store,
  submission,
  registerStartupAttemptHostTests
} from './structured-agent-session-startup-attempt-host-test-support'

registerStartupAttemptHostTests()

it.each([false, true])(
  'keeps current-generation reports across readiness (replaced=%s)',
  async (replaced) => {
    await store.replaceSessionOptions({
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      permissionMode: 'own',
      now: NOW
    })
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    const fence = store.getRecord(SESSION)!.lease.runtimeFence
    const acquisitionGeneration = `generation-${acquire.mock.calls.length}`
    const report = (
      reportedOptions: { reportedPermissionMode?: string | null },
      generation = acquisitionGeneration,
      reportFence = fence
    ) =>
      host.handleAdapterEvent({
        type: 'options-reported',
        sessionId: SESSION,
        fence: reportFence,
        acquisitionGeneration: generation,
        reportedOptions
      })
    const early = report({ reportedPermissionMode: 'accept-edits' })
    expect(host.readStatusSummary(SESSION)?.runtimePermission).toBeNull()
    if (replaced) {
      await host.close(SESSION, 'evict')
      await early
      await proveOpen()
      await host.flushStreamedEvents(SESSION)
      expect(host.readStatusSummary(SESSION)?.runtimePermission).toBeNull()
      return
    }
    await proveOpen()
    await early
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    const current = () => host.readStatusSummary(SESSION)?.runtimePermission
    expect(current()).toEqual({ fence, mode: 'accept-edits' })
    await report({ reportedPermissionMode: 'full-access' }, 'foreign')
    await report({ reportedPermissionMode: 'full-access' }, acquisitionGeneration, fence + 1)
    await report({})
    expect(current()).toEqual({ fence, mode: 'accept-edits' })
    await report({ reportedPermissionMode: null })
    expect(current()).toEqual({ fence, mode: null })
    expect(store.getRecord(SESSION)?.permissionMode).toBe('own')
    expect(dispatch).toHaveBeenCalledTimes(1)
    await host.close(SESSION, 'evict')
    expect(current()).toBeNull()
  }
)

describe('what a started child reports', () => {
  it('keeps provider reports out of the saved next-message choice', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
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
    expect(store.getRecord(SESSION)?.options).toBeUndefined()
  })

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

  it('saves a settings readback that arrives before open proves the start', async () => {
    await restartWith(publishFirst)
    await heldBehindStart('hello')
    const listing = { models: [], configuredDefault: { modelId: 'opus' } }
    const reported = host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reportedOptions: { model: 'opus' },
      catalogListing: listing
    })
    await proveOpen()
    await reported

    await eventually(() => expect(recordLiveListing).toHaveBeenCalledWith(SESSION, listing))
  })
})
