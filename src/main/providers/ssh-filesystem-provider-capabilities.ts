import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'

/** `null` means the host has no capability document at all: it predates
 *  `fs.getCapabilities`, or answered with something that is not an object.
 *  Either way every feature reads as unsupported. */
type RelayFsCapabilities = Record<string, unknown> | null

const capabilitiesByMux = new WeakMap<SshChannelMultiplexer, Promise<RelayFsCapabilities>>()

/** One `fs.getCapabilities` per multiplexer, shared by every feature probe --
 *  the response is a single document, so fetching it once per feature would
 *  spend a round trip for nothing. Keyed by the multiplexer, which is replaced
 *  on reconnect, so a host upgraded behind a reconnect is re-probed.
 *
 *  A failed fetch is evicted so the next probe retries; a resolved one is not,
 *  because a relay does not gain methods without a new connection. */
function readSshFsCapabilities(
  mux: SshChannelMultiplexer,
  signal?: AbortSignal
): Promise<RelayFsCapabilities> {
  const cached = capabilitiesByMux.get(mux)
  const probe =
    cached ??
    mux
      .request('fs.getCapabilities', undefined, { timeoutMs: 5_000 })
      .then((result) =>
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null
      )
      .catch((error) => {
        if (isMethodNotFoundError(error)) {
          return null
        }
        throw error
      })
  if (!cached) {
    capabilitiesByMux.set(mux, probe)
    void probe.catch(() => {
      if (capabilitiesByMux.get(mux) === probe) {
        capabilitiesByMux.delete(mux)
      }
    })
  }
  return waitForSshCapabilityProbe(probe, signal)
}

export function probeSshQuickOpenSearchCapability(
  mux: SshChannelMultiplexer,
  signal?: AbortSignal
): Promise<boolean> {
  return readSshFsCapabilities(mux, signal).then(
    (capabilities) => capabilities?.quickOpenSearchVersion === 1
  )
}

export function probeSshRangedReadCapability(
  mux: SshChannelMultiplexer,
  signal?: AbortSignal
): Promise<boolean> {
  return readSshFsCapabilities(mux, signal).then(
    (capabilities) => capabilities?.rangedReadVersion === 1
  )
}
