// A queued card over an owner no adjudication has concluded about (unreconciled after a reload, or
// latched in recovery), on a chat no tab shows: it may still run, so the card waits, as on main. No
// automatic send starts an agent in its place, stops it, or hands the card back; once a probe
// proves it gone, the card drains.

import { afterEach, expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  leaveUnfinishedWork,
  sendText
} from './structured-agent-session-leftover-settlement.test-fixture'

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

it.each(['unreconciled', 'recovering'] as const)(
  'holds the queued card while the owner is %s, and sends it once the owner is proven gone',
  async (mode) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let ownerGone = false
    rig = await createQueuedMessageTestRig({
      restartable: true,
      probeOwner: async () => {
        if (ownerGone) {
          return { outcome: 'pid-absent' }
        }
        if (mode === 'unreconciled') {
          throw new Error('the probe could not run')
        }
        return { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
      }
    })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current)
    // No visible-tab restore: nothing at startup decides the owner.
    await current.crashReloadHostProcess(() => undefined)
    await current.host.history({ sessionId: SESSION, direction: 'tail' })
    const stopOwnerProcess = vi.fn()
    current.host.deps.stopOwnerProcess = stopOwnerProcess
    const lease = current.store.getRecord(SESSION)?.lease
    expect(mode === 'unreconciled' ? lease?.unreconciled : lease?.handoffStage).toBe(
      mode === 'unreconciled' ? true : 'recovering'
    )
    const starts = current.starts.length
    const dispatches = current.dispatch.mock.calls.length

    const sent = await sendText(current, 'while it may still run').result
    await new Promise((resolve) => setTimeout(resolve, 3_000))

    expect(sent).toMatchObject({ ok: true, value: { queued: expect.anything() } })
    expect(current.starts.length).toBe(starts)
    expect(current.dispatch.mock.calls.length).toBe(dispatches)
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages?.map((card) => card.state)).toEqual(['waiting'])
    expect(page.ok && page.page.queuedMessages?.[0]?.returnedReason).toBeUndefined()
    // Shown as main shows it: unverifiable, not working.
    expect(page.ok && page.page.working).toBe(false)

    ownerGone = true
    await current.host.restoreReadableSessions([SESSION])
    await vi.waitFor(() => expect(current.dispatch.mock.calls.length).toBeGreaterThan(dispatches), {
      timeout: 10_000
    })
    expect(JSON.stringify(current.dispatch.mock.calls.at(-1))).toContain('while it may still run')
    expect(stopOwnerProcess).not.toHaveBeenCalled()
  },
  30_000
)
