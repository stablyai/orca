import type { SavedPortForward } from '../../../shared/remote-runtime/ssh/ssh-types'

export type ForwardMapping = Pick<SavedPortForward, 'localPort' | 'remoteHost' | 'remotePort'>

export function forwardKey(forward: ForwardMapping): string {
  return `${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`
}

/** Live forwards plus saved ones not open now; `dropped` are mappings removed or replaced (#32484). */
export function nextSavedPortForwards(
  active: readonly SavedPortForward[],
  existing: readonly SavedPortForward[],
  dropped: readonly ForwardMapping[] = []
): SavedPortForward[] {
  // A live forward on a saved one's local port replaced it, whatever its destination.
  const activePorts = new Set(active.map((forward) => forward.localPort))
  const droppedKeys = new Set(dropped.map(forwardKey))
  return [
    ...active.map((forward) => ({
      localPort: forward.localPort,
      remoteHost: forward.remoteHost,
      remotePort: forward.remotePort,
      label: forward.label
    })),
    ...existing.filter(
      (forward) => !activePorts.has(forward.localPort) && !droppedKeys.has(forwardKey(forward))
    )
  ]
}
