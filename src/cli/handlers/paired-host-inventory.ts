import { performance } from 'node:perf_hooks'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { HostListEntry } from '../format'
import { listEnvironments } from '../runtime/environments'

const INVENTORY_TIMEOUT_MS = 5_000
const INVENTORY_CONCURRENCY = 4

export async function listPairedEnvironmentHosts(userDataPath: string): Promise<HostListEntry[]> {
  const environments = listEnvironments(userDataPath)
  if (environments.length === 0) {
    return []
  }
  const { sendRemoteRuntimeRequest } = await import('../../shared/remote-runtime-client.js')
  const deadline = performance.now() + INVENTORY_TIMEOUT_MS
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), INVENTORY_TIMEOUT_MS)
  try {
    return await mapWithConcurrency(environments, INVENTORY_CONCURRENCY, async (environment) => {
      const base: HostListEntry = {
        kind: 'environment',
        name: environment.name,
        id: environment.id,
        selector: `--environment ${environment.id}`,
        connectionSource: 'probe'
      }
      const remaining = (): number => Math.max(0, Math.ceil(deadline - performance.now()))
      const unknown = (probeError: string): HostListEntry => ({
        ...base,
        connectionStatus: 'unknown',
        probeError
      })
      if (abort.signal.aborted || remaining() === 0) {
        return unknown('runtime_timeout')
      }
      try {
        // Probe the captured identity without changing pairing state or last-used ordering.
        const pairing = getPreferredPairingOffer(environment)
        const response = await sendRemoteRuntimeRequest<RuntimeStatus>(
          pairing,
          'status.get',
          undefined,
          remaining(),
          undefined,
          abort.signal
        )
        if (!response.ok) {
          return unknown('status_unavailable')
        }
        const host: HostListEntry = { ...base, connected: true, connectionStatus: 'connected' }
        const platform = response.result?.hostPlatform
        if (isHostPlatform(platform)) {
          return { ...host, platform }
        }
        // Older servers expose host.platform even when status.get omits hostPlatform.
        if (remaining() > 0 && !abort.signal.aborted) {
          try {
            const legacy = await sendRemoteRuntimeRequest<{ platform?: string }>(
              pairing,
              'host.platform',
              undefined,
              remaining(),
              undefined,
              abort.signal
            )
            if (legacy.ok && isHostPlatform(legacy.result?.platform)) {
              return { ...host, platform: legacy.result.platform }
            }
          } catch {
            // A missing platform does not invalidate the successful status probe.
          }
        }
        return host
      } catch (error) {
        if (abort.signal.aborted) {
          return unknown('runtime_timeout')
        }
        // Never publish arbitrary remote error text, endpoint addresses, or credentials.
        return unknown(
          error instanceof RemoteRuntimeClientError && error.code === 'runtime_timeout'
            ? 'runtime_timeout'
            : 'probe_failed'
        )
      }
    })
  } finally {
    clearTimeout(timer)
  }
}

function isHostPlatform(value: unknown): value is NodeJS.Platform {
  return (
    typeof value === 'string' &&
    [
      'darwin',
      'linux',
      'win32',
      'aix',
      'freebsd',
      'openbsd',
      'sunos',
      'android',
      'haiku',
      'cygwin',
      'netbsd'
    ].includes(value)
  )
}
