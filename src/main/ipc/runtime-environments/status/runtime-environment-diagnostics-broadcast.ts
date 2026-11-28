import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL } from '../../../../shared/remote-runtime/host-catalog/runtime-environment-diagnostics'
import { getRuntimeDesktopSurface } from '../../../runtime/construction/runtime-desktop-surface'

export type RuntimeEnvironmentDiagnosticsEvent = {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
}

const listeners = new Set<(event: RuntimeEnvironmentDiagnosticsEvent) => void>()

/** Main's own readers of a host's connection state, beside the windows'. */
export function onRuntimeEnvironmentDiagnostics(
  listener: (event: RuntimeEnvironmentDiagnosticsEvent) => void
): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function publishRuntimeEnvironmentDiagnostics(
  event: RuntimeEnvironmentDiagnosticsEvent
): void {
  getRuntimeDesktopSurface().sendToRenderers?.(RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL, event)
  for (const listener of listeners) {
    listener(event)
  }
}
