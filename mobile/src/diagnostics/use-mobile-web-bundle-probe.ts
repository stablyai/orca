import { useCallback, useEffect, useState } from 'react'
import { useHostClient } from '../transport/host-client-hooks'
import { fetchMobileWebBundle } from '../transport/mobile-web-bundle-fetch'
import { readMobileWebBundleErrorCode } from '../transport/mobile-web-bundle-operations'
import { startDiagnosticFetchTimeout } from './diagnostic-fetch-timeout'

// Bound client acquisition so an unopened host cannot leave Connecting… disabled forever; network/request timeouts apply later inside the fetch.
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

// Integrity failures and dispatcher schema refusals have no host code; fall back to the message.
function describeFailure(error: unknown): string {
  const code = readMobileWebBundleErrorCode(error)
  if (code !== null) {
    return code
  }
  return error instanceof Error ? error.message : String(error)
}

// Dev-only: dial on tap, preserving Troubleshoot’s connection-free mount.
// Each run owns an abort signal so reruns, unmount and StrictMode stop chunk reads and release the host’s read slots.
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
      // Dispose acquisition too so an unopened host stops being dialled.
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
