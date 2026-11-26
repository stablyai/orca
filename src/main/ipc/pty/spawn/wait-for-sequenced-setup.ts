import { watch } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { SETUP_AGENT_WAIT_TIMEOUT_SECONDS } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { windowsFsPath } from '../../../wsl/filesystem/wsl-unc-drive-fs-path'

export function waitForSequencedSetup(
  marker: string,
  signal: AbortSignal | undefined
): Promise<number | null> {
  const path = windowsFsPath(marker)
  const name = basename(path)
  const nonce = /\.([0-9a-f-]{36})\.done$/i.exec(name)?.[1]
  if (!nonce || !isAbsolute(path) || signal?.aborted) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (status: number | null): void => {
      if (done) {
        return
      }
      done = true
      watcher.close()
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(status)
    }
    const abort = (): void => finish(null)
    let reading = false
    let changed = false
    const read = async (): Promise<void> => {
      const stats = await stat(path)
      if (stats.isFile() && stats.size <= 96) {
        const [seen, status, extra] = (await readFile(path, 'utf8')).trim().split(':')
        if (seen === nonce && extra === undefined && /^\d{1,10}$/.test(status ?? '')) {
          finish(Number(status))
        }
      }
    }
    const check = (): void => {
      if (done) {
        return
      }
      if (reading) {
        changed = true
        return
      }
      reading = true
      void read()
        .catch(() => {})
        .finally(() => {
          reading = false
          if (changed) {
            changed = false
            check()
          }
        })
    }
    let watcher: ReturnType<typeof watch>
    try {
      watcher = watch(dirname(path), { persistent: false }, (_event, file) => {
        if (!file || file === name) {
          check()
        }
      })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(abort, SETUP_AGENT_WAIT_TIMEOUT_SECONDS * 1000)
    timer.unref()
    watcher.on('error', abort)
    signal?.addEventListener('abort', abort, { once: true })
    check()
  })
}
