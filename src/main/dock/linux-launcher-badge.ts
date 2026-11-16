import { spawnProcess } from '@orca/process-host'
import { app } from 'electron'
import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

/**
 * Linux docks that implement the Unity LauncherEntry D-Bus API (Ubuntu Dock, dash-to-dock,
 * KDE Plasma) draw a count bubble for `application://<desktop file>`, but they drop the entry as
 * soon as the emitting bus connection disappears. Electron's `app.setBadgeCount` only reaches
 * them through libunity on a Unity session, so Orca keeps one long-lived helper that owns the
 * connection and republishes whatever count it is fed on stdin (#41918).
 */

const HELPER_RELATIVE_PATH = ['linux-launcher-badge', 'launcher-badge.py'] as const
const HELPER_UNSUPPORTED_EXIT_CODE = 2
const HELPER_EXIT_GRACE_MS = 1500
const STDERR_TAIL_BYTES = 1024

/** The slice of a piped child process the badge drives; a real ChildProcess satisfies it. */
export type LauncherBadgeHelperProcess = {
  stdin: Writable
  stderr: Readable
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

type HelperSpawner = (spec: {
  program: string
  args: readonly string[]
}) => LauncherBadgeHelperProcess

export type LinuxLauncherBadgeDeps = {
  /** Resolved desktop file the dock knows the app by, e.g. `orca-ide.desktop`. */
  desktopFileName: string
  resolveHelperPath: () => Promise<string | null>
  spawn: HelperSpawner
  warn: (message: string) => void
}

export type LinuxLauncherBadge = {
  setCount: (count: number) => void
  /** Closes the helper's stdin; the helper hides the badge and exits on EOF. */
  dispose: () => void
}

/** Packaged builds ship the helper under resources; development runs it from the repo. */
export async function resolveLauncherBadgeHelperPath(): Promise<string | null> {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, ...HELPER_RELATIVE_PATH) : null,
    join(app.getAppPath(), 'native', ...HELPER_RELATIVE_PATH)
  ]
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next location.
    }
  }
  return null
}

/** electron-builder names the Linux desktop file after the executable (`orca-ide.desktop`). */
export function defaultLauncherDesktopFileName(): string {
  return `${basename(process.execPath)}.desktop`
}

export function createLinuxLauncherBadge(deps: LinuxLauncherBadgeDeps): LinuxLauncherBadge {
  let helper: LauncherBadgeHelperProcess | null = null
  let starting: Promise<void> | null = null
  let unavailable = false
  let disposed = false
  let wantedCount = 0
  let publishedCount: number | null = null

  const giveUp = (why: string): void => {
    if (!unavailable) {
      unavailable = true
      deps.warn(`[linux-launcher-badge] ${why}`)
    }
    helper = null
  }

  const publish = (): void => {
    if (!helper || !helper.stdin.writable || publishedCount === wantedCount) {
      return
    }
    publishedCount = wantedCount
    helper.stdin.write(`${wantedCount}\n`)
  }

  const start = async (): Promise<void> => {
    const helperPath = await deps.resolveHelperPath()
    if (disposed || unavailable) {
      return
    }
    if (!helperPath) {
      giveUp('helper script not found; dock badge disabled')
      return
    }
    let stderrTail = ''
    const child = deps.spawn({ program: 'python3', args: [helperPath, deps.desktopFileName] })
    // A helper that died between checks turns the next write into EPIPE; the exit handler reports it.
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    })
    child.on('error', (error) => {
      giveUp(`could not start python3 helper; dock badge disabled: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      if (disposed) {
        helper = null
        return
      }
      const detail = stderrTail.trim()
      giveUp(
        code === HELPER_UNSUPPORTED_EXIT_CODE
          ? `host cannot publish launcher badges (${detail || 'python3-gi missing'}); dock badge disabled`
          : `helper exited unexpectedly (code ${code}, signal ${signal})${detail ? `: ${detail}` : ''}; dock badge disabled`
      )
    })
    helper = child
    publish()
  }

  return {
    setCount(count) {
      wantedCount = count
      if (disposed || unavailable) {
        return
      }
      if (helper) {
        publish()
        return
      }
      // Hiding an already hidden badge needs no helper; spawn only once there is something to show.
      if (count > 0 && !starting) {
        starting = start().catch((error: unknown) => {
          giveUp(`helper start failed; dock badge disabled: ${String(error)}`)
        })
      }
    },
    dispose() {
      disposed = true
      const child = helper
      helper = null
      if (!child) {
        return
      }
      child.stdin.end()
      // SIGTERM also hides the badge before exit, for a helper that stopped reading.
      const fallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
        }
      }, HELPER_EXIT_GRACE_MS)
      fallback.unref()
    }
  }
}

export function createDefaultLinuxLauncherBadge(): LinuxLauncherBadge {
  return createLinuxLauncherBadge({
    desktopFileName: defaultLauncherDesktopFileName(),
    resolveHelperPath: resolveLauncherBadgeHelperPath,
    spawn: (spec) => spawnProcess({ ...spec, stdio: 'pipe' }),
    warn: (message) => console.warn(message)
  })
}
