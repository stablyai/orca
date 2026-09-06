/**
 * Why an SFTP stream needs an `'error'` listener that outlives its transfer.
 *
 * ssh2 answers an SFTP request by invoking the pending request's callback from inside
 * the protocol parser, on the socket's `data` handler stack. For a write stream that
 * callback is `WriteStream.open`'s, and it does a bare `this.emit('error', err)`. Node
 * throws when `'error'` is emitted on an emitter with no listener, so once a transfer
 * has settled and removed its listener, a late STATUS reply becomes a *synchronous
 * throw* out of `Protocol.parse` -> `Socket.emit('data')`.
 *
 * That is an uncaught exception, not a rejection: `installUnhandledRejectionLogging`
 * absorbs rejections, but `installUncaughtPipeErrorGuard` re-throws uncaught exceptions
 * and the app dies (#15479). A jump host that sandboxes the SFTP subsystem into its own
 * chroot makes a late `SSH_FX_NO_SUCH_FILE` the normal answer, so the listener has to
 * outlive the transfer rather than the other way round.
 *
 * `runSftpFallbackTransfer` already does this for the session emitter; this is the same
 * guarantee one level down, on the streams.
 */

/** SSH_FX_* status code ssh2 copies onto the `Error` it builds from a STATUS reply. */
const SSH_FX_NO_SUCH_FILE = 2

type ErrorEmitter = {
  on(event: 'error', listener: (err: Error) => void): unknown
}

type SftpSessionEmitter = ErrorEmitter & {
  once(event: 'close', listener: () => void): unknown
  removeListener(event: 'error', listener: (err: Error) => void): unknown
}

export type SftpStreamErrorLatch = {
  /** Call once the transfer has settled; any error after this point is the late one. */
  markTransferSettled(): void
}

export function latchLateSftpStreamErrors(
  stream: ErrorEmitter,
  remotePath: string
): SftpStreamErrorLatch {
  let settled = false
  stream.on('error', (err: Error) => {
    if (!settled) {
      // The transfer's own listener owns this error and will reject with it.
      return
    }
    console.warn(
      `[sftp] Ignored late stream error for ${remotePath}: ${err instanceof Error ? err.message : String(err)}`
    )
  })
  return {
    markTransferSettled: () => {
      settled = true
    }
  }
}

/**
 * Hold one `'error'` listener on the SFTP *session* for as long as the session lives.
 *
 * A transfer that attaches and removes its own session listener — `writeStringViaSftp`
 * does, so a session error can reject the write in flight — leaves the emitter with zero
 * listeners between transfers and after the last one. A late STATUS reply arriving in
 * that window is the synchronous throw described above. Errors during a transfer still
 * reach that transfer first: it prepends its listener ahead of this one.
 *
 * Attach this once, right after `conn.sftp()`, on every path that runs transfers over a
 * session it owns.
 */
export function latchLateSftpSessionErrors(sftp: SftpSessionEmitter): void {
  const swallowLateSftpError = (): void => {}
  sftp.on('error', swallowLateSftpError)
  sftp.once('close', () => sftp.removeListener('error', swallowLateSftpError))
}

/**
 * A chrooted SFTP subsystem answers a path outside its namespace with
 * `SSH_FX_NO_SUCH_FILE`, because the path genuinely does not exist in the view it
 * serves. `SSH_FX_PERMISSION_DENIED` is not that: it is an ordinary mode/ownership
 * refusal on a path the subsystem *can* see — a read-only home, a root-owned parent,
 * a quota — and rewriting it into "your bastion chroots SFTP" would send the user to
 * fix ProxyJump for a `chmod`.
 */
export function isSandboxedSftpNamespaceError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === SSH_FX_NO_SUCH_FILE
}

/**
 * SFTP is not optional for a bundled-ssh2 relay install — `SshConnection.sftp()` is the
 * only transfer route on that transport, and the exec-based `tar`/`cat` transfers are
 * bound to the system-SSH transport, not selectable per operation. So a sandboxed SFTP
 * subsystem is a clean failure with an actionable message, not a degraded mode.
 */
export function describeSandboxedSftpFailure(error: unknown, remotePath: string): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return Object.assign(
    new Error(
      `Relay install could not reach ${remotePath} over SFTP (${detail}). ` +
        'The host answered the shell channel but its SFTP subsystem sees a different filesystem — ' +
        'typically a bastion or jump host that chroots SFTP to a transfer directory. ' +
        'Orca cannot install the relay through a sandboxed SFTP subsystem; connect to the target ' +
        'host directly (for example with ProxyJump) or allow SFTP access to the account home.',
      { cause: error }
    ),
    { sandboxedSftpNamespace: true }
  )
}
