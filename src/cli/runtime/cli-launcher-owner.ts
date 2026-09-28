import { connect } from 'node:net'

export const CLI_LAUNCHER_CHANNEL_ENV = 'ORCA_CLI_LAUNCHER_CHANNEL'

/** The launcher owns this process even when it dies without forwarding a signal. */
export function installCliLauncherOwner(): void {
  const owned = process.env[CLI_LAUNCHER_CHANNEL_ENV] === '1'
  const pipe = process.env.ORCA_CLI_LAUNCHER_PIPE
  delete process.env[CLI_LAUNCHER_CHANNEL_ENV]
  delete process.env.ORCA_CLI_LAUNCHER_PIPE
  let stopped = false
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    if (process.platform === 'win32') {
      // Windows kill(SIGTERM) bypasses shutdown handlers.
      if (!process.emit('SIGTERM', 'SIGTERM')) {
        process.exit(143)
      }
    } else {
      process.kill(process.pid, 'SIGTERM')
    }
  }
  if (process.platform === 'win32' && pipe) {
    const owner = connect(pipe)
    owner.on('error', stop)
    owner.once('close', stop)
    owner.once('end', stop)
    // Single-byte signals also work when pipe reads split or combine writes.
    owner.on('data', (data: Buffer) => {
      for (const byte of data) {
        if (byte === 73 && !process.emit('SIGINT', 'SIGINT')) {
          process.exit(130)
        } else if (byte === 84) {
          stop()
        }
      }
    })
    owner.unref()
  }
  if (!owned || typeof process.send !== 'function') {
    return
  }
  process.once('disconnect', stop)
  process.channel?.unref()
  if (!process.connected) {
    stop()
  }
}
