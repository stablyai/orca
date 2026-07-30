import type { RpcContext } from './core'

// Why: single enforcement point for Phase 1 grant scoping — every allowlisted
// method that accepts a terminal handle from a peer device calls this before
// touching runtime state, so a peer can never read/subscribe/write a terminal
// the host did not explicitly grant it.
export function assertPeerTerminalGranted(
  ctx: Pick<RpcContext, 'isPeerDevice' | 'getGrantedTerminals'>,
  terminal: string
): void {
  if (!ctx.isPeerDevice) {
    return
  }
  const granted = ctx.getGrantedTerminals?.() ?? []
  if (!granted.includes(terminal)) {
    throw new Error('peer_terminal_not_granted')
  }
}
