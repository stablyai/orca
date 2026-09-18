import { useCallback, useRef, useState } from 'react'
import { fetchMobileWebBundle } from '../transport/mobile-web-bundle-fetch'
import { readMobileWebBundleErrorCode } from '../transport/mobile-web-bundle-operations'
import type { RpcClient } from '../transport/rpc-client'

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
 *  no code and reads as the sentence it threw. */
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
 */
export function useMobileWebBundleProbe(client: RpcClient | null): {
  state: MobileWebBundleProbeState
  run: () => void
} {
  const [state, setState] = useState<MobileWebBundleProbeState>({ status: 'idle' })
  const runIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(() => {
    if (!client) {
      setState({ status: 'failed', detail: 'no paired host is connected' })
      return
    }
    // A second tap abandons the first run rather than racing it to the same state.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setState({ status: 'running' })
    fetchMobileWebBundle({ client, signal: controller.signal }).then(
      (fetched) => {
        if (runIdRef.current !== runId) {
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
        if (runIdRef.current !== runId) {
          return
        }
        setState({ status: 'failed', detail: describeFailure(error) })
      }
    )
  }, [client])

  return { state, run }
}
