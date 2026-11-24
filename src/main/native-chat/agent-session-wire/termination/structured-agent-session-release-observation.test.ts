import { eventually } from '../host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRestTestRig,
  foundRestTestChat,
  type RestTestRig
} from '../host/testing/structured-agent-session-rest-test-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../host/testing/structured-agent-session-host-test-data.test-fixture'

let rig: RestTestRig

async function finishedRun(idleMs?: () => number | null): Promise<void> {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000, idleMs } })
  await foundRestTestChat(rig)
}

const agentRunning = () => rig.host.loadedSessionIds().length > 0

afterEach(async () => {
  await rig.dispose()
})

describe('releasing a finished background run', () => {
  it('says what it saw: busy while the provider holds a send, released once it stops', async () => {
    await finishedRun()
    rig.adapter.holdsDispatch.mockReturnValue(true)

    expect(await rig.host.releaseIdleSession(SESSION, true)).toBe('busy')
    expect(agentRunning()).toBe(true)

    rig.adapter.holdsDispatch.mockReturnValue(false)
    await eventually(async () => {
      expect(await rig.host.releaseIdleSession(SESSION, true)).toBe('released')
      expect(agentRunning()).toBe(false)
    })
  })
})
