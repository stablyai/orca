import { expect, it } from 'vitest'
import type { RuntimeClientEvent } from '../../../../../shared/remote-runtime/session-graph/runtime-client-events'
import { retryOnHostConnect } from './sleeping-mail-crew-watch'

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
