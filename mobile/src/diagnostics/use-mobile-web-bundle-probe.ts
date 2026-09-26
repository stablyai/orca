import { useCallback, useEffect, useState } from 'react'
import { useHostClient } from '../transport/client-context'
import { fetchMobileWebBundle } from '../transport/mobile-web-bundle-fetch'
import { readMobileWebBundleErrorCode } from '../transport/mobile-web-bundle-operations'
import { startDiagnosticFetchTimeout } from './diagnostic-fetch-timeout'

/**
 * How long a tap waits for the host's client object before it gives up.
 *
 * Generous, because acquiring one can queue behind another screen's, but bounded, because none of
 * that is a network round trip: the connect and request timeouts live below this, inside the fetch,
 * and only apply once a client exists. Without a bound here a host that never opens leaves the row
 * reading `Connecting…` with its button disabled for the life of the screen.
 */
const HOST_CLIENT_DIAL_DEADLINE_MS = 10_000

export type MobileWebBundleProbeState =
  | { status: 'idle' }
  | { status: 'running' }
  | {
      status: 'done'
      buildId: string
      assetCount: number
      totalBytes: number
      elapsedMs: number
    }
  | { status: 'failed'; detail: string }

/** The host's own code when it refused, its message otherwise. A client-side integrity failure has
 *  no code, and so does a schema refusal the dispatcher raised before the handler ran. */
function describeFailure(error: unknown): string {
  const code = readMobileWebBundleErrorCode(error)
  if (code !== null) {
    return code
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Drives one bundle fetch from the troubleshooting screen. Dev-only: nothing in a shipped build
 * mounts this, and nothing here caches or renders what it downloads.
 *
 * The host is dialled on the first tap, not on mount: acquiring a client is what opens a connection,
 * and opening Troubleshoot opened none before this row existed. Each request owns its
 * `AbortController` so a re-run, an unmount, or StrictMode's second mount abandons the previous
 * fetch instead of racing it — and, since the fetch checks that signal before every chunk, stops its
 * reads rather than letting them hold the host's read slots.
 */
export function useMobileWebBundleProbe(hostId: string | null): {
  state: MobileWebBundleProbeState
  run: () => void
  awaitingHost: boolean
} {
  const [state, setState] = useState<MobileWebBundleProbeState>({ status: 'idle' })
  const [request, setRequest] = useState<{ id: number } | null>(null)
  const { client } = useHostClient(request !== null && hostId !== null ? hostId : undefined)

  useEffect(() => {
    if (request === null || client === null) {
      return
    }
    let abandoned = false
    const controller = new AbortController()
    fetchMobileWebBundle({ client, signal: controller.signal }).then(
      (fetched) => {
        if (abandoned) {
          return
        }
        setState({
          status: 'done',
          buildId: fetched.manifest.buildId,
          assetCount: fetched.assets.size,
          totalBytes: fetched.totalBytes,
          elapsedMs: fetched.elapsedMs
        })
      },
      (error: unknown) => {
        if (abandoned) {
          return
        }
        setState({ status: 'failed', detail: describeFailure(error) })
      }
    )
    return () => {
      abandoned = true
      controller.abort()
    }
  }, [client, request])

  useEffect(() => {
    if (request === null || client !== null) {
      return
    }
    const deadline = startDiagnosticFetchTimeout(HOST_CLIENT_DIAL_DEADLINE_MS)
    const giveUp = () => {
      setState({
        status: 'failed',
        detail: `no client for the host within ${HOST_CLIENT_DIAL_DEADLINE_MS / 1000}s`
      })
      // Drops the acquisition too, so a host that never opens stops being dialled.
      setRequest(null)
    }
    deadline.signal.addEventListener('abort', giveUp)
    return () => {
      // Removed first: `dispose` aborts a signal it has not already aborted.
      deadline.signal.removeEventListener('abort', giveUp)
      deadline.dispose()
    }
  }, [client, request])

  const run = useCallback(() => {
    if (hostId === null) {
      setState({ status: 'failed', detail: 'no paired host to fetch from' })
      return
    }
    setState({ status: 'running' })
    setRequest((previous) => ({ id: (previous?.id ?? 0) + 1 }))
  }, [hostId])

  return { state, run, awaitingHost: request !== null && client === null }
}
