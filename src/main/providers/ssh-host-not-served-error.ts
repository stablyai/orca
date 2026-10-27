/** ssh: identifies a target this process cannot serve; managed servers route through runtime:. */
export const SSH_HOST_NOT_SERVED_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

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
