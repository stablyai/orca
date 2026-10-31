const REMOTE_SFTP_OPERATION_TIMEOUT_MS = 10_000

export function sftpOperation<T>(
  label: string,
  run: (callback: (err: unknown, value?: T) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      // A wedged SFTP callback must not block workspace startup indefinitely.
      reject(new Error(`Timed out waiting for SFTP ${label}`))
    }, REMOTE_SFTP_OPERATION_TIMEOUT_MS)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    const finish = (err: unknown, value?: T): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (err) {
        reject(err)
        return
      }
      // SAFETY: Successful callbacks supply the value specified by each SFTP operation.
      resolve(value as T)
    }

    try {
      run(finish)
    } catch (error) {
      finish(error)
    }
  })
}
