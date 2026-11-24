import { afterEach, expect, it, vi } from 'vitest'
import { CrewChanges } from '../../crew/crew-changes'
import type { RuntimeClientEvent } from '../../../../../shared/remote-runtime/session-graph/runtime-client-events'
import { retryOnHostConnect, SleepingMailCrewWatch } from './sleeping-mail-crew-watch'

function hostEvent(targetId: string, status: string): RuntimeClientEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host-edge reader reads only type, targetId and state.status.
  return { type: 'sshStateChanged', targetId, state: { status } } as unknown as RuntimeClientEvent
}

it.each([100, 1_000])(
  'retains no host after %i connect/disconnect lifecycles, retrying once per genuine connect',
  (count) => {
    let listener: (event: RuntimeClientEvent) => void = () => {}
    let retries = 0
    const connected = retryOnHostConnect(
      (next) => {
        listener = next
      },
      {
        retryFailed: () => {
          retries += 1
        },
        trackedMailboxes: () => []
      },
      () => {}
    )
    for (let index = 0; index < count; index++) {
      const host = `ssh-target-${index}`
      listener(hostEvent(host, 'connected'))
      // A host broadcasts its status many times while it stays up.
      listener(hostEvent(host, 'connected'))
      listener(hostEvent(host, 'disconnected'))
    }
    expect(retries).toBe(count)
    expect(connected.size).toBe(0)
  }
)

afterEach(() => {
  vi.useRealTimers()
})

it.each([100, 1_000])(
  'a burst of %i crew changes that name nothing re-checks the owed mailboxes once a second',
  async (count) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const changes = new CrewChanges()
    const owed = Array.from({ length: count }, (_, index) => `run:owed-${index}`)
    let rechecked = 0
    const watch = new SleepingMailCrewWatch(
      () => changes,
      (scope) => {
        rechecked += [...scope.mailboxes].length
      },
      () => owed
    )
    watch.sync(true)
    try {
      for (let second = 0; second < 3; second += 1) {
        for (let change = 0; change < count; change += 1) {
          changes.notify(new Set(['topology']))
        }
        await vi.advanceTimersByTimeAsync(1_000)
      }
      // Three seconds of changes: three re-checks of the owed set, not one per change.
      expect(rechecked).toBeLessThanOrEqual(3 * count)
    } finally {
      watch.sync(false)
    }
  }
)
