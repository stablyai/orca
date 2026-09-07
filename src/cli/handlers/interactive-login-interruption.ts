import { execFile, type ChildProcess } from 'node:child_process'

export const LOGIN_PROCESS_POSIX_GRACE_MS = 5_000
export const LOGIN_PROCESS_CLOSE_FALLBACK_MS = 1_000
export const WINDOWS_LOGIN_TREE_KILL_TIMEOUT_MS = 5_000

type WindowsTreeKiller = (rootPid: number) => Promise<void>

type TerminationDependencies = {
  platform?: NodeJS.Platform
  killWindowsTree?: WindowsTreeKiller
  posixGraceMs?: number
  closeFallbackMs?: number
}

export type InteractiveLoginSession = {
  child: ChildProcess | null
  registering: boolean
  terminationPromise: Promise<void> | null
}

const INTERRUPT_EXIT_CODES: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
const INTERRUPT_SIGNALS = Object.keys(INTERRUPT_EXIT_CODES) as NodeJS.Signals[]

function waitForClose(closePromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    closePromise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

function killDirectChild(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // The child may close between the timeout and fallback signal.
  }
}

export function terminateWindowsLoginProcessTree(
  rootPid: number,
  execFileImpl: typeof execFile = execFile
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    execFileImpl(
      'taskkill',
      ['/pid', String(rootPid), '/T', '/F'],
      { timeout: WINDOWS_LOGIN_TREE_KILL_TIMEOUT_MS, windowsHide: true },
      () => resolve()
    )
  })
}

/**
 * Stops an interrupted interactive login before its credential directory is removed.
 * The final close wait is bounded because a broken child handle must not hang Ctrl-C.
 */
export async function terminateInteractiveLoginProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  deps: TerminationDependencies = {}
): Promise<void> {
  let closed = false
  let resolveClose: (() => void) | undefined
  const onClose = (): void => {
    closed = true
    resolveClose?.()
  }
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve
  })
  child.once('close', onClose)

  const platform = deps.platform ?? process.platform
  const closeFallbackMs = deps.closeFallbackMs ?? LOGIN_PROCESS_CLOSE_FALLBACK_MS
  try {
    if (platform === 'win32') {
      if (child.pid) {
        const killTree = deps.killWindowsTree ?? terminateWindowsLoginProcessTree
        await killTree(child.pid).catch(() => {})
        if (closed || (await waitForClose(closePromise, closeFallbackMs))) {
          return
        }
      }
      killDirectChild(child)
      if (closed) {
        return
      }
      await waitForClose(closePromise, closeFallbackMs)
      return
    }

    killDirectChild(child, signal)
    const posixGraceMs = deps.posixGraceMs ?? LOGIN_PROCESS_POSIX_GRACE_MS
    if (closed || (await waitForClose(closePromise, posixGraceMs))) {
      return
    }
    killDirectChild(child, 'SIGKILL')
    await waitForClose(closePromise, closeFallbackMs)
  } finally {
    child.off('close', onClose)
  }
}

/**
 * Runs an account add with signal-safe cleanup and primary-error precedence.
 */
export async function withInteractiveLoginCleanup<T>(
  session: InteractiveLoginSession,
  cleanup: () => Promise<void>,
  add: () => Promise<T>
): Promise<T> {
  let cleanupPromise: Promise<void> | null = null
  let cleanupFailureReported = false
  const cleanupOnce = (): Promise<void> =>
    (cleanupPromise ??= (async () => {
      await session.terminationPromise
      await cleanup()
    })())
  const reportCleanupFailure = (error: unknown): void => {
    if (cleanupFailureReported) {
      return
    }
    cleanupFailureReported = true
    console.warn('[account] Failed to clean up the temporary login directory:', error)
  }
  const onSignal = (signal: NodeJS.Signals): void => {
    if (session.child) {
      session.terminationPromise ??= terminateInteractiveLoginProcess(session.child, signal)
    }
    if (session.registering) {
      console.warn(
        '[account] Interrupted after sign-in completed; the account may still have been registered. Run `orca account list` to check.'
      )
    }
    void cleanupOnce()
      .catch(reportCleanupFailure)
      .finally(() => process.exit(INTERRUPT_EXIT_CODES[signal] ?? 1))
  }
  // Why: repeated signals must keep awaiting the same cleanup instead of restoring Node defaults.
  for (const signal of INTERRUPT_SIGNALS) {
    process.on(signal, onSignal)
  }
  let addFailed = false
  let addError: unknown
  let addResult: { value: T } | null = null
  try {
    addResult = { value: await add() }
  } catch (error) {
    addFailed = true
    addError = error
  }
  let cleanupError: unknown
  try {
    await cleanupOnce()
  } catch (error) {
    cleanupError = error
  } finally {
    for (const signal of INTERRUPT_SIGNALS) {
      process.off(signal, onSignal)
    }
  }
  if (addFailed) {
    if (cleanupError !== undefined) {
      // Why: retain the error that explains the failed account add.
      reportCleanupFailure(cleanupError)
    }
    throw addError
  }
  if (cleanupError !== undefined) {
    throw cleanupError
  }
  return addResult!.value
}
