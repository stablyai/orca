import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'

const quickOpenSearchSupport = new WeakMap<SshChannelMultiplexer, Promise<boolean>>()

export function probeSshQuickOpenSearchCapability(
  mux: SshChannelMultiplexer,
  signal?: AbortSignal
): Promise<boolean> {
  const cached = quickOpenSearchSupport.get(mux)
  const probe =
    cached ??
    mux
      .request('fs.getCapabilities', undefined, { timeoutMs: 5_000 })
      .then((result) => {
        const version = (result as { quickOpenSearchVersion?: unknown } | null)
          ?.quickOpenSearchVersion
        return version === 1
      })
      .catch((error) => {
        if (isMethodNotFoundError(error)) {
          return false
        }
        throw error
      })
  if (!cached) {
    quickOpenSearchSupport.set(mux, probe)
  }
  return waitForSshCapabilityProbe(probe, signal).then(
    (supported) => supported,
    (error) => {
      if (!signal?.aborted && quickOpenSearchSupport.get(mux) === probe) {
        quickOpenSearchSupport.delete(mux)
      }
      throw error
    }
  )
}
