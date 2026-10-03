// A client that is not the desktop window (a phone, the CLI, a remote host's peer) can send before
// startup's lease check has settled the previous run's owner. The send is accepted into the chat
// at once; the agent it needs starts only after the check, through the agent start's own check.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import {
  createRestTestRig,
  restTestChat,
  sendRestTestMessage,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

const CHAT = 'session-a'

let rig: RestTestRig
// A failed assertion must not leave teardown waiting on a held probe.
let releaseProbe = (): void => undefined

beforeEach(async () => {
  rig = await createRestTestRig()
})

afterEach(async () => {
  releaseProbe()
  await rig.dispose()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

describe('a send during a slow startup lease check', () => {
  it('is accepted at once, and its agent starts once, after the check', async () => {
    await restTestChat(rig, CHAT, { message: 'before the restart' })
    await rig.crash()
    const probe = Promise.withResolvers<void>()
    const probing = Promise.withResolvers<void>()
    releaseProbe = probe.resolve
    let checked = false
    rig.probeOwner.mockImplementation(async () => {
      probing.resolve()
      await probe.promise
      checked = true
      return { outcome: 'pid-absent' }
    })
    const host = await rig.boot()
    const startupCheck = host.reconcileRestartLeases()
    await probing.promise
    // Each start, with whether the check had adjudicated the chat's lease by then.
    const starts: { checked: boolean; unreconciled: boolean | undefined }[] = []
    const acquire = rig.adapter.acquire.getMockImplementation()
    rig.adapter.acquire.mockImplementation(async (input) => {
      starts.push({ checked, unreconciled: rig.store.getRecord(CHAT)?.lease.unreconciled })
      if (!acquire) {
        throw new Error('the rig acquires through its own implementation')
      }
      return acquire(input)
    })

    const first = await sendRestTestMessage(rig, CHAT, 'first after the restart')
    expect(first, JSON.stringify(first)).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    // Queued behind the first one's delivery, which is waiting on the check.
    const second = sendRestTestMessage(rig, CHAT, 'second after the restart')
    // Long enough for a delivery that did not wait to have started its agent.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(starts).toEqual([])
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()

    probe.resolve()
    await startupCheck
    expect(await second, 'second send').toMatchObject({ ok: true })
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2), {
      timeout: 10_000
    })

    expect(starts).toEqual([{ checked: true, unreconciled: false }])
    const submissions = (await host.journalSnapshot(CHAT)).submissions.slice(-2)
    expect(submissions.map((entry) => entry.dispatchState)).toEqual(['accepted', 'accepted'])
  })
})
