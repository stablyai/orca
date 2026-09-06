// Integrator wiring (Unit 8): resolves "the worktree's active agent terminal" for ask-answer
// sending and terminal-tail opening (spec S7/S8). Fail-closed (finding #1 of the critical
// review): a most-recent-output heuristic over terminal.list can guess the wrong terminal —
// sending "1\r"/"\r"/Esc keystrokes to an unrelated agent or a plain shell — whenever
// agentIdentity is absent or a worktree hosts multiple agents. terminal.resolveActive is the
// host's own authoritative "the" active terminal for a worktree; if it returns no handle, there
// is no terminal to answer to and callers must not send.
import type { RpcPort, RpcSuccess } from '../transport/orca-rpc-wire'

type ResolveActiveResult = { handle?: string | null }

/** Returns the worktree's authoritative active terminal handle, or null if none/ambiguous. */
export async function resolveActiveTerminalHandle(
  port: RpcPort,
  worktreeId: string
): Promise<string | null> {
  const response = await port.sendRequest('terminal.resolveActive', {
    worktree: `id:${worktreeId}`
  })
  if (!response.ok) {
    return null
  }
  const result = (response as RpcSuccess).result as ResolveActiveResult
  return result.handle ?? null
}

type TerminalListResult = { terminals?: { handle: string }[] }

// VERIFIED host fact: terminal.agentStatus {terminal} -> { agentStatus }, agentStatus.state in
// {'working','blocked','waiting','done','idle'} (src/shared/agent-status-types.ts). 'waiting'
// and 'blocked' both mean "needs input" — the RuntimeTerminalSummary rows terminal.list returns
// carry no status field, so each candidate terminal needs its own terminal.agentStatus call.
const NEEDS_INPUT_STATES: ReadonlySet<string> = new Set(['waiting', 'blocked'])

export type WaitingTerminalResolution = { handle: string } | { ambiguous: true } | { none: true }

/**
 * Resolves the worktree's UNIQUE terminal currently needing input (CRITICAL finding #10):
 * terminal.resolveActive tracks desktop FOCUS, not which terminal actually asked, so it is not
 * safe for routing ask-answer keystrokes — a focus change between the notification firing and
 * the wearer clicking would send the answer to the wrong agent. Fails closed to `none`/
 * `ambiguous` on zero or multiple matches, or on any RPC failure: never guess which terminal to
 * write to.
 */
export async function resolveWaitingTerminalHandle(
  port: RpcPort,
  worktreeId: string
): Promise<WaitingTerminalResolution> {
  const listResponse = await port.sendRequest('terminal.list', { worktree: `id:${worktreeId}` })
  if (!listResponse.ok) {
    return { none: true }
  }
  const terminals = ((listResponse as RpcSuccess).result as TerminalListResult).terminals ?? []
  if (terminals.length === 0) {
    return { none: true }
  }
  const statuses = await Promise.all(
    terminals.map((terminal) => probeNeedsInput(port, terminal.handle))
  )
  const waiting = terminals.filter((_, i) => statuses[i]).map((t) => t.handle)
  if (waiting.length === 1) {
    return { handle: waiting[0]! }
  }
  return waiting.length === 0 ? { none: true } : { ambiguous: true }
}

type TerminalAgentStatusResult = { agentStatus?: { state?: string } | null }

/** A failed/unreadable individual probe excludes that terminal rather than guessing it's
 *  waiting — consistent with the fail-closed contract above. */
async function probeNeedsInput(port: RpcPort, terminal: string): Promise<boolean> {
  try {
    const response = await port.sendRequest('terminal.agentStatus', { terminal })
    if (!response.ok) {
      return false
    }
    const agentStatus = ((response as RpcSuccess).result as TerminalAgentStatusResult).agentStatus
    return (
      agentStatus !== null &&
      agentStatus !== undefined &&
      NEEDS_INPUT_STATES.has(agentStatus.state ?? '')
    )
  } catch {
    return false
  }
}
