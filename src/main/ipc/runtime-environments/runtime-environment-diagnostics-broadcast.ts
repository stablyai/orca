import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL } from '../../../shared/remote-runtime/host-catalog/runtime-environment-diagnostics'
import { getRuntimeDesktopSurface } from '../../runtime/runtime-desktop-surface'

export type RuntimeEnvironmentDiagnosticsEvent = {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
}

export function publishRuntimeEnvironmentDiagnostics(
  event: RuntimeEnvironmentDiagnosticsEvent
): void {
  getRuntimeDesktopSurface().sendToRenderers?.(RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL, event)
}
