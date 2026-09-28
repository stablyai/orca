import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { resolveDesktopDaemonBunRuntime, type DaemonBunRuntime } from '../daemon/daemon-bun-runtime'
import { resolveWindowsBunPtyGateEntry } from '../daemon/pty-subprocess/windows-bun-pty-launch'

type RuntimeCache = {
  key: string
  promise: Promise<DaemonBunRuntime | null>
  users: number
  invalidated: boolean
  released: boolean
}
let cached: RuntimeCache | null = null
let watchingShutdown = false

function releaseUnused(entry: RuntimeCache): void {
  if (!entry.invalidated || entry.users !== 0 || entry.released) {
    return
  }
  entry.released = true
  void entry.promise.then((runtime) => runtime?.releaseLaunchPin?.()).catch(() => {})
}
function invalidate(entry: RuntimeCache): void {
  entry.invalidated = true
  if (cached === entry) {
    cached = null
  }
  releaseUnused(entry)
}
export function disposeWindowsConsoleRuntime(): void {
  if (cached) {
    invalidate(cached)
  }
}

/** A cached path owns its pin; pending spawns keep invalidated entries alive until used. */
export async function acquireWindowsConsoleRuntime(timeoutMs: number) {
  if (process.versions.bun) {
    return {
      execPath: process.execPath,
      entryPath: resolveWindowsBunPtyGateEntry(),
      release() {},
      invalidate() {}
    }
  }
  const environment = process.versions.electron ? getAppEnvironment() : null
  if (environment && !watchingShutdown) {
    environment.onWillQuit(disposeWindowsConsoleRuntime)
    watchingShutdown = true
  }
  const key = environment
    ? `${environment.getAppPath()}\0${environment.getVersion()}`
    : process.execPath
  if (cached?.key !== key) {
    disposeWindowsConsoleRuntime()
    cached = {
      key,
      promise: resolveDesktopDaemonBunRuntime(),
      users: 0,
      invalidated: false,
      released: false
    }
  }
  const entry = cached
  entry.users++
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    entry.users--
    releaseUnused(entry)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const runtime = await waitForPromiseWithSignal(entry.promise, controller.signal)
    if (!runtime) {
      invalidate(entry)
      release()
      return null
    }
    return {
      execPath: runtime.execPath,
      entryPath: join(dirname(runtime.entryPath), 'windows-bun-pty-gate-entry.js'),
      release,
      invalidate: () => invalidate(entry)
    }
  } catch (error) {
    invalidate(entry)
    release()
    throw error
  } finally {
    clearTimeout(timer)
  }
}
