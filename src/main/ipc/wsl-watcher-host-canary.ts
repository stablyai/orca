import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WatcherBindingWatchdog } from './wsl-watcher-host-binding-watchdog'

type CanaryWatcherBinding = {
  subscribe(dir: string, callback: (error: Error | null) => void, options: object): Promise<void>
  unsubscribe(dir: string, callback: (error: Error | null) => void, options: object): Promise<void>
}

export type WslWatcherCanary = { close(): Promise<void> }

const CANARY_INTERVAL_MS = 10_000
const CANARY_EVENT_TIMEOUT_MS = 5_000
const CANARY_MAX_MISSES = 2
const CANARY_DIR_PATTERN = /^orca-wsl-watcher-(\d+)-/

// Why: hard kills from the Windows side (wsl.exe teardown) never run the
// 'exit' handler, so each host start reclaims directories whose owner died.
export function sweepStaleWslWatcherCanaryDirectories(
  baseDir: string = tmpdir(),
  isProcessAlive: (pid: number) => boolean = (pid) => existsSync(`/proc/${pid}`)
): void {
  let entries: string[]
  try {
    entries = readdirSync(baseDir)
  } catch {
    return
  }
  for (const entry of entries) {
    const owner = Number(CANARY_DIR_PATTERN.exec(entry)?.[1])
    if (!Number.isSafeInteger(owner) || owner === process.pid || isProcessAlive(owner)) {
      continue
    }
    try {
      rmSync(join(baseDir, entry), { recursive: true, force: true })
    } catch {
      // Another sweeper or the filesystem may win the race; try again next start.
    }
  }
}

export async function startWslWatcherCanary(
  binding: CanaryWatcherBinding,
  watchdog: WatcherBindingWatchdog
): Promise<WslWatcherCanary> {
  if (process.platform === 'linux') {
    sweepStaleWslWatcherCanaryDirectories()
  }
  const dir = mkdtempSync(join(tmpdir(), `orca-wsl-watcher-${process.pid}-`))
  let lastEventAt = 0
  const callback = (error: Error | null): void => {
    if (!error) {
      lastEventAt = Date.now()
    }
  }
  const options = {}
  const removeDirectory = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Temporary canary cleanup is best-effort during process exit.
    }
  }
  let clearTimers = (): void => undefined
  const cleanupOnExit = (): void => {
    clearTimers()
    removeDirectory()
  }
  // Why: process.exit from a subscribe watchdog does not unwind to the catch;
  // the temporary directory must already be owned by an exit handler.
  process.once('exit', cleanupOnExit)
  try {
    await watchdog.watch('canary subscribe', binding.subscribe(dir, callback, options))
  } catch (error) {
    process.removeListener('exit', cleanupOnExit)
    removeDirectory()
    throw error
  }
  let misses = 0
  const probes = new Set<ReturnType<typeof setTimeout>>()
  const interval = setInterval(() => {
    const probedAt = Date.now()
    try {
      writeFileSync(join(dir, 'canary.txt'), String(probedAt))
    } catch {
      return
    }
    const probe = setTimeout(() => {
      probes.delete(probe)
      if (lastEventAt >= probedAt) {
        misses = 0
      } else if (++misses >= CANARY_MAX_MISSES) {
        process.stderr.write('[wsl-watcher-host] native event delivery stalled\n')
        process.exit(2)
      }
    }, CANARY_EVENT_TIMEOUT_MS)
    probes.add(probe)
  }, CANARY_INTERVAL_MS)
  clearTimers = (): void => {
    clearInterval(interval)
    for (const probe of probes) {
      clearTimeout(probe)
    }
    probes.clear()
  }
  let closing: Promise<void> | undefined
  return {
    close: () => {
      closing ??= (async () => {
        clearTimers()
        try {
          await watchdog.watch('canary unsubscribe', binding.unsubscribe(dir, callback, options))
        } finally {
          process.removeListener('exit', cleanupOnExit)
          removeDirectory()
        }
      })()
      return closing
    }
  }
}
