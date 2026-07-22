export type PtyProcessInfo = {
  id: string
  cwd: string
  title: string
  shellPath?: string
  /** Owning worktree when the provider can report it authoritatively. */
  worktreeId?: string
  /** Trusted ORCA_TERMINAL_HANDLE exported into this PTY, when known. */
  terminalHandle?: string
}
