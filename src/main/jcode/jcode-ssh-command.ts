import { getSshConnectionManager } from '../ipc/ssh'

/** A live SSH connection object returned by the connection manager. */
export type SshConnection = NonNullable<
  ReturnType<NonNullable<ReturnType<typeof getSshConnectionManager>>['getConnection']>
>

/** Minimal single-quote shell escaping for a POSIX path argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Resolve a live, connected SSH connection by id, or null. */
export function getLiveSshConnection(connectionId: string): SshConnection | null {
  const conn = getSshConnectionManager()?.getConnection(connectionId)
  if (!conn || conn.getState().status !== 'connected') {
    return null
  }
  return conn
}

/** Run a remote command over SSH and require a zero exit status. */
export function runRemoteCommand(conn: SshConnection, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn
      .exec(command)
      .then((channel) => {
        let exitCode: number | null = null
        let stderr = ''
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) {
            return
          }
          settled = true
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        }
        channel.on('exit', (code: number | null) => {
          exitCode = code
        })
        channel.on('close', () => {
          if (exitCode === 0) {
            finish()
            return
          }
          const suffix = exitCode === null ? 'without an exit code' : `with exit code ${exitCode}`
          const detail = stderr.trim() ? `: ${stderr.trim()}` : ''
          finish(new Error(`Remote command failed ${suffix}${detail}`))
        })
        channel.on('error', (err: Error) => finish(err))
        // Drain so the channel can close.
        channel.on('data', () => {})
        channel.stderr?.on('data', (data: Buffer | string) => {
          stderr += data.toString()
        })
      })
      .catch(reject)
  })
}

/** Run a remote command over SSH and capture stdout. */
export function runRemoteCapture(conn: SshConnection, command: string): Promise<string | null> {
  const TIMEOUT_MS = 10_000
  return new Promise((resolve) => {
    conn
      .exec(command)
      .then((channel) => {
        let stdout = ''
        let exitCode: number | null = null
        let settled = false
        const finish = (value: string | null): void => {
          if (settled) {
            return
          }
          settled = true
          if (timer) {
            clearTimeout(timer)
          }
          resolve(value)
        }
        const timer = setTimeout(() => finish(null), TIMEOUT_MS)
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
        channel.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        channel.stderr?.on('data', () => {})
        channel.on('exit', (code: number | null) => {
          exitCode = code
        })
        channel.on('close', () => finish(exitCode === 0 ? stdout : null))
        channel.on('error', () => finish(null))
        channel.stderr?.on('error', () => {})
      })
      .catch(() => resolve(null))
  })
}
