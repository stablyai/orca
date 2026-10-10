import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Delay before retrying registration (ms). */
const RETRY_DELAY_MS = 2_000

/**
 * Registers the Electron tray with KDE's StatusNotifierWatcher.
 * Electron registers with object path /StatusNotifierItem/1, but KDE expects
 * the bare service name. This workaround calls RegisterStatusNotifierItem
 * with the bare name so the icon appears in the Plasma panel.
 *
 * Linux-only. Safe to call multiple times (idempotent).
 * Retries once after a delay if the first attempt fails.
 */
export async function registerTrayWithSniWatcher(): Promise<void> {
  if (process.platform !== 'linux') {
    return
  }

  const pid = process.pid
  const serviceName = `org.freedesktop.StatusNotifierItem-${pid}-1`

  const attempt = async (): Promise<void> => {
    try {
      await execFileAsync('gdbus', [
        'call',
        '--session',
        '--dest',
        'org.kde.StatusNotifierWatcher',
        '--object-path',
        '/StatusNotifierWatcher',
        '--method',
        'org.kde.StatusNotifierWatcher.RegisterStatusNotifierItem',
        serviceName
      ])
    } catch (error) {
      // gdbus may not be available, or the watcher may reject the call.
      // This is a best-effort workaround; the tray still works via the
      // standard StatusNotifierItem registration even if this fails.
      if (typeof error === 'object' && error !== null) {
        const err = error as { code?: string }
        if (err.code !== 'ENOENT') {
          // Only log non-ENOENT errors to avoid noise when gdbus is missing
          console.warn('[tray-sni-registration] failed to register with watcher:', error)
        }
      }
    }
  }

  await attempt()

  // Retry once after a delay to handle race conditions where the watcher
  // hasn't fully initialized yet or the first call was rejected.
  const retry = setTimeout(() => {
    void attempt()
  }, RETRY_DELAY_MS)
  retry.unref?.()
}
