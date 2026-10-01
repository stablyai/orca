import type { EventEmitter } from 'node:events'
import type { SshConnectionWorkLedger } from './ssh-connection-work-ledger'
import type { SshTransportCloseLedger } from './ssh-transport-close-ledger'
import { observeSshTransportClose } from './ssh-transport-close-observation'

type WorkFence = ReturnType<SshConnectionWorkLedger['fenceForReset']>

/**
 * Disconnects, then waits for the live transport resources, every client ever allocated and all
 * fenced work to close. Listeners go on before close starts so a fast 'close' is not missed.
 */
export async function disconnectAndAwaitSshTransportClose(options: {
  liveResources: readonly EventEmitter[]
  disconnect: () => Promise<void>
  transportCloseLedger: SshTransportCloseLedger
  fence: WorkFence
  signal: AbortSignal
}): Promise<void> {
  const observation = observeSshTransportClose(options.liveResources)
  const waiting = new AbortController()
  const waitSignal = AbortSignal.any([options.signal, waiting.signal])
  try {
    await options.disconnect()
    await Promise.all([
      observation.wait(waitSignal),
      options.transportCloseLedger.drain(waitSignal),
      options.fence.drain(waitSignal)
    ])
    options.fence.assertDrained()
  } finally {
    waiting.abort()
    observation.dispose()
  }
}
