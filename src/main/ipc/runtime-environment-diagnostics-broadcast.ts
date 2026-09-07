import { BrowserWindow } from 'electron'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../shared/remote-runtime-shared-control-types'
import { RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL } from '../../shared/runtime-environment-diagnostics'

export { RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL }

export type RuntimeEnvironmentDiagnosticsEvent = {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
}

export function publishRuntimeEnvironmentDiagnostics(
  event: RuntimeEnvironmentDiagnosticsEvent
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL, event)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}
