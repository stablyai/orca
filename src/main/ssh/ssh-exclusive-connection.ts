import type { SshTarget } from '../../shared/ssh-types'
import { SshConnection, type SshConnectionCallbacks } from './ssh-connection'
import { assertProfileLifetimeAdmission } from './profile-lifetime-admission'

export async function connectExclusiveSshConnection(
  target: SshTarget,
  options: { signal: AbortSignal; assertAuthority: () => void },
  pool: {
    callbacks: SshConnectionCallbacks
    register: (connection: SshConnection) => void
    isRegistered: (connection: SshConnection) => boolean
    disconnect: (connection: SshConnection, drain?: boolean) => Promise<void>
    releaseReservation: () => void
  }
): Promise<{ connection: SshConnection; release: () => Promise<void> }> {
  const { signal, assertAuthority } = options
  let released = false
  let connection: SshConnection | undefined
  let connectSettled = false
  let interruption: Promise<{ error: unknown } | undefined> | undefined
  const assertCurrent = (): void => {
    assertProfileLifetimeAdmission()
    assertAuthority()
    signal.throwIfAborted()
    if (released || (connection && !pool.isRegistered(connection))) {
      throw new Error('ssh_exclusive_connection_changed')
    }
  }
  let cleanup: Promise<void> | undefined
  const release = (): Promise<void> => {
    released = true
    signal.removeEventListener('abort', onAbort)
    cleanup ??= (async () => {
      const interrupted = await interruption
      const errors: unknown[] = interrupted ? [interrupted.error] : []
      if (connection) {
        try {
          await pool.disconnect(connection, true)
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'ssh_exclusive_interruption_and_drain_failed')
      }
      pool.releaseReservation()
    })()
    return cleanup
  }
  const onAbort = (): void => {
    if (connectSettled) {
      void release().catch(() => {})
      return
    }
    released = true
    // Interrupt promptly, but retain ownership until settled allocation has proven physical closure.
    if (connection) {
      interruption ??= pool.disconnect(connection, false).then(
        () => undefined,
        (error: unknown) => ({ error })
      )
    }
  }
  try {
    assertCurrent()
    connection = new SshConnection(
      target,
      {
        onStateChange: () => {},
        onCredentialRequest: async (targetId, kind, detail, requestSignal) => {
          assertCurrent()
          const credentialSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal
          credentialSignal.throwIfAborted()
          const answer = await pool.callbacks.onCredentialRequest?.(
            targetId,
            kind,
            detail,
            credentialSignal
          )
          assertCurrent()
          credentialSignal.throwIfAborted()
          return answer ?? null
        }
      },
      { automaticReconnect: false }
    )
    pool.register(connection)
    signal.addEventListener('abort', onAbort, { once: true })
    assertCurrent()
    try {
      await connection.connect()
    } finally {
      connectSettled = true
    }
    assertCurrent()
    return { connection, release }
  } catch (error) {
    connectSettled = true
    try {
      await release()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'ssh_exclusive_connection_cleanup_failed')
    }
    throw error
  }
}
