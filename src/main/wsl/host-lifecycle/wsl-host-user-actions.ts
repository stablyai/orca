/**
 * The user's own Add and Remove of a WSL host: a Remove is the user declining the host, and only
 * their Add (or Retry) takes that back. Removes are reported by the host service itself, which
 * only the user's sidebar and Settings paths reach; Adds by the user's IPC, since the move
 * orchestrator adds hosts through the same service.
 */
export type WslHostUserAction = { kind: 'added' | 'removed'; distro: string }

const listeners = new Set<(action: WslHostUserAction) => void>()

export function onWslHostUserAction(listener: (action: WslHostUserAction) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function noteWslHostUserAction(action: WslHostUserAction): void {
  for (const listener of listeners) {
    listener(action)
  }
}
