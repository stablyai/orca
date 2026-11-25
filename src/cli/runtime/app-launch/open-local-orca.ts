import type { CliStatusResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { launchOrcaApp } from '../launch'
import { RuntimeClientError, RuntimeRpcFailureError } from '../connection/types'
import type { RuntimeRpcSuccess } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

type ReadStatus = () => Promise<RuntimeRpcSuccess<CliStatusResult>>
type OpenWindowInBackground = (options: {
  timeoutMs: number
}) => Promise<RuntimeRpcSuccess<{ requested: boolean }>>

// The runtime only queues a window request; a stuck one must not hold `orca open` for a full RPC timeout.
const OPEN_WINDOW_RPC_TIMEOUT_MS = 5_000

export async function openLocalOrca(
  readStatus: ReadStatus,
  openWindowInBackground: OpenWindowInBackground,
  timeoutMs: number
): Promise<RuntimeRpcSuccess<CliStatusResult>> {
  const startedAt = Date.now()
  let requested = false
  do {
    const status = await getStatusForOpen(readStatus)
    if (status !== undefined) {
      const windowStatus = status?.result.app.desktopWindowStatus
      // A blocked runtime cannot open a window; a second app would only hit its instance lock.
      if (windowStatus === 'blocked') {
        throwDesktopActivationBlocked()
      }
      if (!requested) {
        // Relaunching a running Orca would hand it the foreground, so ask it to show its own window.
        const asked =
          status?.result.runtime.reachable === true &&
          (await askToOpenWindow(openWindowInBackground))
        if (!asked && windowStatus !== 'available') {
          launchOrcaApp()
        }
        requested = true
      }
      if (status && windowStatus === 'available') {
        return status
      }
    }
    await delay(250)
  } while (Date.now() - startedAt < timeoutMs)

  throw new RuntimeClientError(
    'runtime_open_timeout',
    'Timed out waiting for an Orca desktop window. The runtime may still be running headlessly.'
  )
}

async function getStatusForOpen(
  readStatus: ReadStatus
): Promise<RuntimeRpcSuccess<CliStatusResult> | null | undefined> {
  try {
    return await readStatus()
  } catch (error) {
    if (error instanceof RuntimeClientError && !(error instanceof RuntimeRpcFailureError)) {
      if (error.code === 'runtime_unavailable') {
        return null
      }
      // The pipe can be published while startup work still holds the main thread.
      if (error.code === 'runtime_timeout') {
        return undefined
      }
    }
    throw error
  }
}

async function askToOpenWindow(openWindowInBackground: OpenWindowInBackground): Promise<boolean> {
  try {
    const response = await openWindowInBackground({ timeoutMs: OPEN_WINDOW_RPC_TIMEOUT_MS })
    return response.result.requested === true
  } catch {
    // Older runtimes lack the method; any failure falls back to relaunching, as open always did.
    return false
  }
}

function throwDesktopActivationBlocked(): never {
  throw new RuntimeClientError(
    'desktop_activation_blocked',
    'Orca is running headlessly, but it cannot open a desktop window safely because the persistent terminal provider is unavailable. Quit Orca normally and start the app again; do not use open -n.'
  )
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
