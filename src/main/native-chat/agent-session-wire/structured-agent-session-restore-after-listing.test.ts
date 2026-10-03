// The restore pass runs after the tab list is out, so the app is already usable while it works
// through the chats. A chat closed, or a host quit, before the pass reaches it stays that way.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import {
  createRestTestRig,
  restTestChat,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { restTestOpens } from './structured-agent-session-rest-test-observations'

const IDS = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5']
const LAST = 'session-5'

let rig: RestTestRig
let releaseHeld = (): void => undefined

beforeEach(async () => {
  rig = await createRestTestRig()
})

afterEach(async () => {
  releaseHeld()
  await rig.dispose()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

/** Boots over a crashed run and starts the pass with its first open held, so it has not reached
 *  the last chat. */
async function bootWithHeldPass() {
  for (const sessionId of IDS) {
    await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
  }
  await rig.crash()
  const host = await rig.boot()
  const held = Promise.withResolvers<void>()
  releaseHeld = held.resolve
  rig.adapter.historyFilePath.mockImplementation(async (sessionId) => {
    if (sessionId === IDS[0]) {
      await held.promise
    }
    return null
  })
  const pass = host.restoreReadableSessions(IDS)
  await vi.waitFor(() => expect(rig.adapter.historyFilePath).toHaveBeenCalledOnce())
  return { host, pass, release: held.resolve }
}

const publishedFor = (sessionId: string): number =>
  rig.sink.publish.mock.calls.filter(([summary]) => summary.sessionId === sessionId).length

describe('the restore pass after the tab list', () => {
  it('does not reopen a chat closed before the pass reached it', async () => {
    const { host, pass, release } = await bootWithHeldPass()

    // What closing the tab does.
    await host.setSessionTabVisibility(LAST, false)
    await host.close(LAST, 'user-close')
    const publishedAtClose = publishedFor(LAST)
    release()
    await pass

    expect(host.hasSession(LAST)).toBe(false)
    expect(restTestOpens(rig, LAST)).toBe(0)
    expect(publishedFor(LAST)).toBe(publishedAtClose)
    expect(host.hasSession('session-1')).toBe(true)
  })

  it('does not open a chat it reached before quit began but opens after', async () => {
    await restTestChat(rig, LAST, { message: 'asked' })
    await rig.crash()
    const host = await rig.boot()
    const { runtimeState, lifetime } = host.collaboratorsForTests()
    // Holds the chat between the pass reaching it and its open.
    const settling = Promise.withResolvers<void>()
    releaseHeld = settling.resolve
    const resolveRecovery = runtimeState.resolveRecovery.bind(runtimeState)
    const recovery = vi.spyOn(runtimeState, 'resolveRecovery').mockImplementation(async (id) => {
      await settling.promise
      return resolveRecovery(id)
    })
    const pass = host.restoreReadableSessions([LAST])
    await vi.waitFor(() => expect(recovery).toHaveBeenCalled())

    const teardown = host.flushAllStreamedEvents()
    await vi.waitFor(() => expect(lifetime.isDisposed()).toBe(true))
    settling.resolve()
    await teardown
    await pass

    expect(restTestOpens(rig, LAST)).toBe(0)
    expect(host.hasSession(LAST)).toBe(false)
  })

  it('opens nothing more, and settles no more leases, once the host is quitting', async () => {
    const { host, pass, release } = await bootWithHeldPass()
    const recovery = vi.spyOn(host.collaboratorsForTests().runtimeState, 'resolveRecovery')

    const teardown = host.flushAllStreamedEvents()
    release()
    await teardown
    await pass

    expect(restTestOpens(rig, LAST)).toBe(0)
    expect(host.hasSession(LAST)).toBe(false)
    expect(recovery).not.toHaveBeenCalledWith(LAST)
  })
})
