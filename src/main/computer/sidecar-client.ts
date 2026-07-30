import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '../../shared/runtime-types'
import { normalizeComputerActionResult } from './computer-action-verification-normalization'
import { ComputerSidecarProcess, type ComputerSidecarMethod } from './computer-sidecar-process'
import { validateComputerSidecarPasteText } from './computer-sidecar-paste-validation'

let sidecar: ComputerSidecarProcess | null = null

// Why: app.exit() skips Electron quit events; sync supervisor cleanup must still run.
process.once('exit', () => sidecar?.shutdown())

export async function callComputerSidecarListApps(): Promise<ComputerListAppsResult> {
  return (await getComputerSidecar().call('listApps', {})) as ComputerListAppsResult
}

export async function callComputerSidecarCapabilities(): Promise<ComputerProviderCapabilities> {
  return (await getComputerSidecar().call('capabilities', {})) as ComputerProviderCapabilities
}

export async function callComputerSidecarListWindows(
  params: unknown
): Promise<ComputerListWindowsResult> {
  return (await getComputerSidecar().call('listWindows', params)) as ComputerListWindowsResult
}

export async function callComputerSidecarSnapshot(
  params: unknown
): Promise<ComputerSnapshotResult> {
  return (await getComputerSidecar().call('getAppState', params)) as ComputerSnapshotResult
}

export async function callComputerSidecarAction(
  method: Exclude<
    ComputerSidecarMethod,
    'capabilities' | 'listApps' | 'listWindows' | 'getAppState'
  >,
  params: unknown
): Promise<ComputerActionResult> {
  const validation = validateComputerSidecarPasteText(method, params)
  if (validation) {
    await validation
  }
  return normalizeComputerActionResult(
    (await getComputerSidecar().call(method, params)) as ComputerActionResult
  )
}

export function resetComputerSidecarForTest(): void {
  sidecar?.shutdown()
  sidecar = null
}

function getComputerSidecar(): ComputerSidecarProcess {
  if (!sidecar) {
    sidecar = new ComputerSidecarProcess()
  }
  return sidecar
}
