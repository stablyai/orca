// Integrator wiring (Unit 8): resolves "the worktree's active agent terminal" for ask-answer
// sending and terminal-tail opening (spec S7/S8). Fail-closed (finding #1 of the critical
// review): a most-recent-output heuristic over terminal.list can guess the wrong terminal —
// sending "1\r"/"\r"/Esc keystrokes to an unrelated agent or a plain shell — whenever
// agentIdentity is absent or a worktree hosts multiple agents.
//
// terminal.resolveActive is NOT in the mobile RPC allowlist (it tracks desktop focus, which a
// mobile-scoped pairing has no business reading anyway), so it must never be called from even-g2.
// Viewing a terminal tail tolerates ambiguity — unlike the ask path below, which must fail closed
// — so resolveViewableTerminalHandle uses the allowlisted terminal.list and picks the best
// candidate to look at rather than the one true answerable terminal.
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalSummary
} from '@orca-shared/runtime-terminal-contracts'
import type { RpcPort, RpcSuccess } from '../transport/orca-rpc-wire'

type TerminalListResult = { terminals?: Pick<RuntimeTerminalSummary, 'handle'>[] }
type ViewableTerminalRow = Pick<RuntimeTerminalSummary, 'handle' | 'agentIdentity' | 'lastOutputAt'>
type ViewableTerminalListResult = { terminals?: ViewableTerminalRow[] }

/**
 * Picks a terminal worth VIEWING for the terminal-tail screen: prefer a row that carries a
 * host-resolved agentIdentity (an actual agent, not a plain shell), tie-broken by the newest
 * lastOutputAt; otherwise fall back to the newest lastOutputAt across all candidates. Returns
 * null when the worktree has no terminals at all. Ambiguity here is fine — the wearer is just
 * looking, not sending keystrokes — so this never fails closed the way resolveWaitingTerminalHandle
 * does.
 */
export async function resolveViewableTerminalHandle(
  port: RpcPort,
  worktreeId: string
): Promise<string | null> {
  const response = await port.sendRequest('terminal.list', { worktree: `id:${worktreeId}` })
  if (!response.ok) {
    return null
  }
  const terminals = ((response as RpcSuccess).result as ViewableTerminalListResult).terminals ?? []
  if (terminals.length === 0) {
    return null
  }
  const withIdentity = terminals.filter((t) => t.agentIdentity != null)
  const pool = withIdentity.length > 0 ? withIdentity : terminals
  return pool.reduce((best, candidate) =>
    (candidate.lastOutputAt ?? -Infinity) > (best.lastOutputAt ?? -Infinity) ? candidate : best
  ).handle
}

// VERIFIED contract (src/shared/runtime-terminal-contracts.ts): terminal.agentStatus {terminal}
// -> RuntimeTerminalAgentStatus = { handle, isRunningAgent, status }, where status is
// 'working' | 'permission' | 'idle' | null. "Needs input" is precisely status === 'permission'.
// terminal.list's RuntimeTerminalSummary rows carry no status field, so each candidate terminal
// needs its own terminal.agentStatus call.
export type WaitingTerminalResolution = { handle: string } | { ambiguous: true } | { none: true }

/**
 * Resolves the worktree's UNIQUE terminal currently needing input (CRITICAL finding #1):
 * terminal.resolveActive tracks desktop FOCUS, not which terminal actually asked, so it is not
 * safe for routing ask-answer keystrokes — a focus change between the notification firing and
 * the wearer clicking would send the answer to the wrong agent. Fails closed to `none`/
 * `ambiguous` on zero or multiple matches, AND on any probe that can't be verified (RPC failure
 * or a throw): an unverifiable candidate must never be silently excluded, since that would let
 * us "prove" uniqueness we haven't actually established.
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
  const outcomes = await Promise.all(
    terminals.map((terminal) => probeAgentStatus(port, terminal.handle))
  )
  if (outcomes.some((outcome) => outcome === 'unverifiable')) {
    // Fail closed (never guess): at least one candidate's status couldn't be observed, so
    // uniqueness of the waiting terminal can't be proven even if the others look conclusive.
    return { ambiguous: true }
  }
  const waiting = terminals.filter((_, i) => outcomes[i] === 'permission').map((t) => t.handle)
  if (waiting.length === 1) {
    return { handle: waiting[0]! }
  }
  return waiting.length === 0 ? { none: true } : { ambiguous: true }
}

type TerminalAgentStatusResult = { agentStatus?: RuntimeTerminalAgentStatus }

type ProbeOutcome = 'permission' | 'other' | 'unverifiable'

/** A failed RPC, a throw, or a malformed/missing agentStatus payload is `unverifiable` — the
 *  caller fails the whole resolution closed rather than treating it as "not waiting". */
async function probeAgentStatus(port: RpcPort, terminal: string): Promise<ProbeOutcome> {
  try {
    const response = await port.sendRequest('terminal.agentStatus', { terminal })
    if (!response.ok) {
      return 'unverifiable'
    }
    const agentStatus = ((response as RpcSuccess).result as TerminalAgentStatusResult).agentStatus
    if (!agentStatus) {
      return 'unverifiable'
    }
    return agentStatus.status === 'permission' ? 'permission' : 'other'
  } catch {
    return 'unverifiable'
  }
}
