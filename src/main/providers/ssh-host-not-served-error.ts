/** ssh: identifies a target this process cannot serve; managed servers route through runtime:. */
export const SSH_HOST_NOT_SERVED_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

/** Reconnecting cannot help: only the host's Orca server could delete there, and it lacks this project. */
export const SSH_WORKTREE_REMOVAL_NOT_SERVED_MESSAGE =
  'Orca can’t delete this workspace on its SSH host because its project isn’t served by Orca’s server there. Remove it from Orca instead; files on the host are left untouched.'

export const SSH_GIT_RECONNECT_MESSAGE =
  'SSH Git provider is not available. Reconnect to this target and try again.'

export function sshTargetNotConnectedMessage(connectionId: string): string {
  return `SSH connection "${connectionId}" not found or not connected`
}

// Preserve Error: message through Electron IPC; a custom name would change renderer-visible errors.
export class SshHostNotServedError extends Error {
  readonly code = 'ssh_host_not_served'

  constructor(
    readonly connectionId: string,
    message: string = SSH_HOST_NOT_SERVED_MESSAGE
  ) {
    super(message)
  }
}
