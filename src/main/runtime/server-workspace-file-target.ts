/** A workspace on a server this desktop is a client of, as its own window opens files there. */
export type ServerWorkspaceFileTarget = {
  environmentId: string
  worktreeId: string
  worktreePath: string
}
