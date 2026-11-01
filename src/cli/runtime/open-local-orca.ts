import type { CliStatusResult } from '../../shared/runtime-types'
import { launchOrcaApp } from './launch'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'

type ReadStatus = () => Promise<RuntimeRpcSuccess<CliStatusResult>>

export async function openLocalOrca(
  readStatus: ReadStatus,
  timeoutMs: number
): Promise<RuntimeRpcSuccess<CliStatusResult>> {
  const initial = await getStatusForOpen(readStatus)

  // A blocked runtime cannot open a window; a second app would only hit its instance lock.
  if (initial?.result.app.desktopWindowStatus === 'blocked') {
    throwDesktopActivationBlocked()
  }
  launchOrcaApp()
  if (initial?.result.app.desktopWindowStatus === 'available') {
    return initial
  }

  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getStatusForOpen(readStatus)
    if (status?.result.app.desktopWindowStatus === 'blocked') {
      throwDesktopActivationBlocked()
    }
    if (status?.result.app.desktopWindowStatus === 'available') {
      return status
    }
    await delay(250)
  }

  throw new RuntimeClientError(
    'runtime_open_timeout',
    'Timed out waiting for an Orca desktop window. The runtime may still be running headlessly.'
  )
}

async function getStatusForOpen(
  readStatus: ReadStatus
): Promise<RuntimeRpcSuccess<CliStatusResult> | null> {
  try {
    return await readStatus()
  } catch (error) {
    // Explicit open may launch after an unavailable endpoint; a denied or rejected call cannot.
    if (
      error instanceof RuntimeClientError &&
      !(error instanceof RuntimeRpcFailureError) &&
      error.code === 'runtime_unavailable'
    ) {
      return null
    }
    throw error
  }
}

function throwDesktopActivationBlocked(): never {
  throw new RuntimeClientError(
    'desktop_activation_blocked',
    'Orca is running headlessly, but it cannot open a desktop window safely because the persistent terminal provider is unavailable. Quit Orca normally and start the app again; do not use open -n.'
  )
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
