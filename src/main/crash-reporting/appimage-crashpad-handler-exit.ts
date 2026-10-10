// AppImage: Crashpad's handler outlives us on the FUSE mount and SIGBUSes once it is unmounted
// (#22542). Stopped, not relocated: Electron always launches it from the executable's directory.
// A main-process crash runs no exit hook, so the handler still faults after writing that dump.

import { readdirSync, readlinkSync, statSync } from 'node:fs'
// posix: /proc paths are Linux-only, and tests run this matcher on every host.
import { posix } from 'node:path'
import { resolveAppImageRuntimeIdentity } from '../appimage-runtime-identity'

function listPids(): number[] {
  try {
    return readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
  } catch {
    return []
  }
}

function readExecutable(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`)
  } catch {
    return null
  }
}

// Extract-and-run reuses one digest-named dir across concurrent launches and has no FUSE mount to lose.
function isRunningFromOwnMount(runtimeRoot: string): boolean {
  try {
    return statSync(runtimeRoot).dev !== statSync(posix.dirname(runtimeRoot)).dev
  } catch {
    return false
  }
}

/**
 * Why process 'exit': it is the last hook of a committed quit, and it also runs on SIGTERM (session
 * logout). will-quit can still be deferred by teardown, which would leave the app running unreported.
 */
export function installAppImageCrashpadHandlerExit(): void {
  const runtimeRoot = posix.dirname(process.execPath)
  // Why resolve now: validation reads the AppImage file, which may be moved or deleted by exit.
  if (!resolveAppImageRuntimeIdentity() || !isRunningFromOwnMount(runtimeRoot)) {
    return
  }
  // The mount path is unique per launch, so only this launch's handler matches.
  const handlerPath = posix.join(runtimeRoot, 'chrome_crashpad_handler')
  process.once('exit', () => {
    for (const pid of listPids()) {
      if (readExecutable(pid) !== handlerPath) {
        continue
      }
      try {
        // Why SIGKILL: SIGTERM runs the handler's own signal code, whose cold pages race the unmount.
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })
}
