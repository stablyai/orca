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
