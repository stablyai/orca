// Stop the handler before AppImage FUSE unmount invalidates its executable pages.
// Main-process crashes bypass exit hooks, so the handler may still fault after writing the dump.

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

/** Use Node's final exit phase because Electron can defer will-quit. */
export function installAppImageCrashpadHandlerExit(): void {
  const runtimeRoot = posix.dirname(process.execPath)
  // Validate now because the AppImage may be moved or deleted before exit.
  if (!resolveAppImageRuntimeIdentity() || !isRunningFromOwnMount(runtimeRoot)) {
    return
  }
  const handlerPath = posix.join(runtimeRoot, 'chrome_crashpad_handler')
  process.once('exit', () => {
    for (const pid of listPids()) {
      if (readExecutable(pid) !== handlerPath) {
        continue
      }
      try {
        // SIGTERM executes handler code that may fault as FUSE unmounts; SIGKILL does not.
        process.kill(pid, 'SIGKILL')
      } catch {
        // The handler may already have exited.
      }
    }
  })
}
