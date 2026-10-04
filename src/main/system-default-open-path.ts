import { shell } from 'electron'
import { dirname } from 'node:path'
import { spawnProcess } from '../shared/child-process/run-process'
import { withTimeout } from '../shared/promise-timeout-fallback'

// Electron's Linux shell.openPath drops its completion callback.
export const LINUX_OPEN_PATH_SETTLE_BOUND_MS = 1_500

/** Linux opens must reply without treating an unknown launcher outcome as success. */
export function openPathWithSystemDefault(
  targetPath: string,
  onOpened?: () => void
): Promise<string> {
  if (process.platform !== 'linux') {
    const opened = shell.openPath(targetPath)
    return onOpened
      ? opened.then((value) => {
          if (value === '') {
            onOpened()
          }
          return value
        })
      : opened
  }
  const opened = new Promise<string>((resolve, reject) => {
    const child = spawnProcess({
      program: 'xdg-open',
      args: [targetPath],
      cwd: dirname(targetPath),
      env: { ...process.env, MM_NOTTTY: '1' },
      detached: true,
      stdio: 'ignore'
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      resolve(code === 0 ? '' : 'The system default application could not open this path.')
    })
    // A slow opener may be the application itself; timing out must not kill it.
    child.unref()
  })
  const settled = opened.then(
    (value) => {
      if (value === '') {
        onOpened?.()
      }
      return { value }
    },
    (error: unknown) => ({ error })
  )
  return withTimeout<Awaited<typeof settled> | null>(
    settled,
    LINUX_OPEN_PATH_SETTLE_BOUND_MS,
    null
  ).then((result) => {
    if (result === null) {
      return 'The system opener has not confirmed the file was opened. It may still open.'
    }
    if ('error' in result) {
      throw result.error
    }
    return result.value
  })
}
