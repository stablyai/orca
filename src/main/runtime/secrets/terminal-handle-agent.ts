/** The agent a terminal runs and its worktree, as a secret or local-command request's caller. */
export type TerminalHandleAgent = { agent: string | null; worktreeId: string }

/** Reads a terminal handle's host record; never derived from request params. */
export function terminalHandleAgent(
  record: { ptyId?: string | null; worktreeId: string } | undefined,
  agentForPty: (ptyId: string) => string | null
): TerminalHandleAgent | null {
  if (!record) {
    return null
  }
  return { agent: record.ptyId ? agentForPty(record.ptyId) : null, worktreeId: record.worktreeId }
}
