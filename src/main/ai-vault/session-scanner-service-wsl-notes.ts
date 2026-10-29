import { onWslDistroGateNote } from '../wsl-background-distro-gate'

type WslNoteChannel = {
  send(message: unknown, callback: (error: Error | null) => void): boolean
}

/**
 * The child's transcript gate cannot hear main's WSL stop and wake notes; without them it trusts a
 * running read for its whole lease. Returns the unsubscribe.
 */
export function forwardWslDistroNotesToChild(child: () => WslNoteChannel | null): () => void {
  return onWslDistroGateNote((note) =>
    child()?.send({ type: 'wslDistroNote', ...note }, () => undefined)
  )
}
