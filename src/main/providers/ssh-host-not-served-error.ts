/**
 * An `ssh:<target>` host names an SSH target, never a route: this process serves no SSH provider,
 * so work routed to one fails with this error. A managed host is reached as `runtime:<env>`.
 */
export const SSH_HOST_NOT_SERVED_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

/** The wording SSH review-head fetches have always used. */
export const SSH_GIT_RECONNECT_MESSAGE =
  'SSH Git provider is not available. Reconnect to this target and try again.'

/** The wording project registration on an SSH target has always used. */
export function sshTargetNotConnectedMessage(connectionId: string): string {
  return `SSH connection "${connectionId}" not found or not connected`
}

// Why no custom `name`: Electron IPC rejects with `${error}`, so the renderer keeps seeing
// `Error: <message>`, the text these paths showed before the typed error existed.
export class SshHostNotServedError extends Error {
  readonly code = 'ssh_host_not_served'

  constructor(
    readonly connectionId: string,
    message: string = SSH_HOST_NOT_SERVED_MESSAGE
  ) {
    super(message)
  }
}
