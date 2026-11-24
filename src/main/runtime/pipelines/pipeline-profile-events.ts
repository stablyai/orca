import type { PluginService } from '../../plugins/plugin-service'

const listeners = new Set<() => void>()
let stopPluginEvents: (() => void) | undefined
export function observePluginPipelineProfiles(service: PluginService | null): void {
  stopPluginEvents?.()
  stopPluginEvents = service?.onChanged(notifyPipelineProfilesChanged)
  notifyPipelineProfilesChanged()
}
export function onPipelineProfilesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function notifyPipelineProfilesChanged(): void {
  for (const listener of listeners) {
    listener()
  }
}
