// Integrator wiring (Unit 8): resolves "the worktree's live agent terminal" for ask-answer
// sending and terminal-tail opening (spec S7/S8) via terminal.list. The real host's
// terminal.list rows are RuntimeTerminalSummary (`handle`, `agentIdentity?`, `lastOutputAt`);
// there is no createdAt/kind field to sort a true "newest" by, so this mirrors the host's own
// resolveActiveTerminal fallback: prefer agent-tagged rows, rank by lastOutputAt, else keep
// array order. Mock fixtures use `terminalId` instead of `handle` — both are tolerated.
import type { RpcPort, RpcSuccess } from '../transport/orca-rpc-wire'

type TerminalListRow = {
  handle?: string
  terminalId?: string
  agentIdentity?: unknown
  lastOutputAt?: number | null
}

type TerminalListResult = { terminals?: TerminalListRow[] }

function rowId(row: TerminalListRow): string | null {
  return row.handle ?? row.terminalId ?? null
}

function pickNewestAgentTerminal(rows: TerminalListRow[]): string | null {
  const withId = rows.filter((row) => rowId(row) !== null)
  if (withId.length === 0) {
    return null
  }
  const agentRows = withId.filter(
    (row) => row.agentIdentity !== undefined && row.agentIdentity !== null
  )
  const pool = agentRows.length > 0 ? agentRows : withId
  const newest = [...pool].sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0))[0]
  return newest ? rowId(newest) : null
}

export async function resolveAgentTerminalId(
  port: RpcPort,
  worktreeId: string
): Promise<string | null> {
  const response = await port.sendRequest('terminal.list', {
    worktree: `id:${worktreeId}`,
    includeVisualLayouts: false
  })
  if (!response.ok) {
    return null
  }
  const result = (response as RpcSuccess).result as TerminalListResult
  return pickNewestAgentTerminal(result.terminals ?? [])
}
