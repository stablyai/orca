import type { SshConnectionManager } from '../connection/ssh-connection-manager'
import { buildPosixStdoutFence } from '../../../shared/shell/launch/posix-stdout-fence'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'

const SSH_HOME_READ_TIMEOUT_MS = 15_000

/** One small file under the host's `$HOME` (Hermes' `active_profile`), or null when absent. */
export async function readSshHomeTextFile(
  manager: SshConnectionManager | null,
  targetId: string,
  relativePath: string
): Promise<string | null> {
  const connection = manager?.getConnection(targetId)
  if (!connection) {
    return null
  }
  // Login shells may print banners before the payload; the fence keeps only the file's bytes.
  const command = `cat -- "$HOME"/${quotePosixShell(relativePath)}`
  const fence = buildPosixStdoutFence(command, 'SSH')
  let channel
  try {
    channel = await connection.execWithClosedStdin(fence.command)
  } catch {
    return null
  }
  const { promise, resolve } = Promise.withResolvers<string | null>()
  let stdout = ''
  let exitCode: number | null = null
  let exitObserved = false
  let settled = false
  const finish = (value: string | null): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timeout)
    resolve(value)
  }
  const timeout = setTimeout(() => {
    try {
      channel.close()
    } catch {
      // Closing a dying channel must not mask its result.
    }
    finish(null)
  }, SSH_HOME_READ_TIMEOUT_MS)
  channel.on('data', (data: Buffer) => {
    stdout += data.toString()
  })
  channel.on('exit', (code: number | null) => {
    exitObserved = true
    exitCode = code
  })
  channel.on('error', () => finish(null))
  channel.stderr.on('error', () => finish(null))
  channel.on('close', () => {
    const payload = fence.readStdout(stdout)
    finish(
      exitObserved && exitCode === 0 && payload !== null && payload.length > 0 ? payload : null
    )
  })
  return promise
}
