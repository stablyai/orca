import type { RpcContext } from './core'

// Why: revocation must win a stream already open, not just a fresh subscribe —
// the terminal Input binary-frame handlers call this per frame (in addition to
// subscribe time) since grant state can change mid-stream.
export function isPeerTerminalGranted(
  ctx: Pick<RpcContext, 'isPeerDevice' | 'getGrantedTerminals'>,
  terminal: string
): boolean {
  if (!ctx.isPeerDevice) {
    return true
  }
  const granted = ctx.getGrantedTerminals?.() ?? []
  return granted.includes(terminal)
}

// Why: single enforcement point for Phase 1 grant scoping — every allowlisted
// method that accepts a terminal handle from a peer device calls this before
// touching runtime state, so a peer can never read/subscribe/write a terminal
// the host did not explicitly grant it.
export function assertPeerTerminalGranted(
  ctx: Pick<RpcContext, 'isPeerDevice' | 'getGrantedTerminals'>,
  terminal: string
): void {
  if (!isPeerTerminalGranted(ctx, terminal)) {
    throw new Error('peer_terminal_not_granted')
  }
}
