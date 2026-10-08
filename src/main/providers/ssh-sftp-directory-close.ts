import type { SFTPWrapper } from 'ssh2'

const SFTP_DIRECTORY_CLOSE_TIMEOUT_MS = 5_000
const retiredChannels = new WeakSet<SFTPWrapper>()

export function isSftpDirectoryChannelRetired(sftp: SFTPWrapper): boolean {
  return retiredChannels.has(sftp)
}

export function closeSftpDirectoryHandle(
  sftp: SFTPWrapper,
  handle: Buffer
): Promise<Error | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error && !retiredChannels.has(sftp)) {
        retiredChannels.add(sftp)
        try {
          sftp.end()
        } catch {
          // Preserve the CLOSE failure if channel teardown also fails.
        }
      }
      resolve(error)
    }
    const timer = setTimeout(
      () => finish(new Error('SFTP directory CLOSE timed out')),
      SFTP_DIRECTORY_CLOSE_TIMEOUT_MS
    )
    try {
      sftp.close(handle, (error) => finish(error ?? undefined))
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
