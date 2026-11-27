import { createRequire } from 'node:module'

/** node-pty's patched addon (config/patches/node-pty@1.1.0.patch): kqueue NOTE_EXIT, pidfd or a Windows wait. */
type ProcessExitWatchNative = {
  /** A watch id, 0 when no such process exists, or null when this host cannot watch it. */
  watchProcessExit: (pid: number, onNotice: (exited?: boolean) => void) => number | null
  watchProcessExitWithProof?: ProcessExitWatchNative['watchProcessExit']
  unwatchProcessExit: (id: number) => void
}

export type ProcessExitWatch = { dispose: () => void }

const requireFromHere = createRequire(__filename)
let cachedNative: ProcessExitWatchNative | null | undefined
let nativeOverride: ProcessExitWatchNative | null | undefined

function isProcessExitWatchNative(native: unknown): native is ProcessExitWatchNative {
  return (
    typeof native === 'object' &&
    native !== null &&
    'watchProcessExit' in native &&
    typeof native.watchProcessExit === 'function' &&
    'unwatchProcessExit' in native &&
    typeof native.unwatchProcessExit === 'function'
  )
}

function loadProcessExitWatchNative(): ProcessExitWatchNative | null {
  if (nativeOverride !== undefined) {
    return nativeOverride
  }
  if (cachedNative !== undefined) {
    return cachedNative
  }
  // Unit tests opt in through the override; the real addon would watch live pids.
  if (process.env.VITEST === 'true') {
    return null
  }
  try {
    const utils: unknown = requireFromHere('node-pty/lib/utils')
    const native: unknown =
      typeof utils === 'object' &&
      utils !== null &&
      'loadNativeModule' in utils &&
      typeof utils.loadNativeModule === 'function'
        ? utils.loadNativeModule(process.platform === 'win32' ? 'conpty' : 'pty')?.module
        : null
    // An addon built before the patch lacks the watch; callers then keep their event-only behavior.
    cachedNative = isProcessExitWatchNative(native) ? native : null
  } catch {
    cachedNative = null
  }
  return cachedNative
}

/** The notice distinguishes an observed exit from watch failure. 'gone' means the PID was absent. */
export function watchProcessExit(
  pid: number,
  onNotice: (exited: boolean) => void,
  options?: { requireProof: true }
): ProcessExitWatch | 'gone' | null {
  const native = loadProcessExitWatchNative()
  if (!native || !Number.isSafeInteger(pid) || pid <= 0) {
    return null
  }
  let id: number | null
  const watch = options?.requireProof ? native.watchProcessExitWithProof : native.watchProcessExit
  if (!watch) {
    return null
  }
  try {
    id = watch(pid, (exited) => {
      try {
        onNotice(exited === true)
      } catch {
        // An exit notice is advisory; it must never unwind into the native event loop.
      }
    })
  } catch {
    return null
  }
  if (id === 0) {
    return 'gone'
  }
  if (typeof id !== 'number' || id < 0) {
    return null
  }
  const watchId = id
  return {
    dispose: () => {
      try {
        native.unwatchProcessExit(watchId)
      } catch {
        // Already released by its own exit.
      }
    }
  }
}

export function setProcessExitWatchNativeForTests(
  native: ProcessExitWatchNative | null | undefined
): void {
  nativeOverride = native
}
