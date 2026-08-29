const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024
const STDERR_EXIT_DRAIN_MS = 250

type UnrefableChildStderr = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'error' | 'end' | 'close', listener: () => void): unknown
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  off(event: 'error' | 'end' | 'close', listener: () => void): unknown
  destroy(): void
  unref?: () => void
}

type DaemonExitListener = (exitCode: number | null, signal: NodeJS.Signals | null) => void

type ObservableDaemonChild = {
  stderr: UnrefableChildStderr | null
  on(event: 'exit', listener: DaemonExitListener): unknown
  off(event: 'exit', listener: DaemonExitListener): unknown
}

export type DaemonChildExitObservation = {
  verdict: 'exited'
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
}

export type DaemonChildExitObserver = {
  startupStderrTail(): string
  markReady(): void
  stop(options?: { destroyStderr?: boolean }): void
}

function appendStderrTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) {
    return Buffer.alloc(0)
  }
  if (chunk.length >= maxBytes) {
    return Buffer.from(chunk.subarray(-maxBytes))
  }
  const currentBytes = Math.min(current.length, maxBytes - chunk.length)
  return Buffer.concat([current.subarray(-currentBytes), chunk], currentBytes + chunk.length)
}

export function observeDaemonChildExit(
  child: ObservableDaemonChild,
  recordExit: (observation: DaemonChildExitObservation) => void,
  maxStderrBytes = DEFAULT_STDERR_TAIL_BYTES
): DaemonChildExitObserver {
  let stderrTail: Buffer = Buffer.alloc(0)
  let ready = false
  let stopped = false
  let stderrEnded = child.stderr === null
  let pendingExit: Pick<DaemonChildExitObservation, 'exitCode' | 'signal'> | null = null
  let drainTimer: ReturnType<typeof setTimeout> | null = null

  const onStderr = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stderrTail = appendStderrTail(stderrTail, bytes, maxStderrBytes)
  }
  const onStderrError = (): void => {}
  const finalizeExit = (): void => {
    if (stopped || !pendingExit) {
      return
    }
    stopped = true
    if (drainTimer) {
      clearTimeout(drainTimer)
    }
    child.off('exit', onProcessExit)
    child.stderr?.off('data', onStderr)
    child.stderr?.off('error', onStderrError)
    child.stderr?.off('end', onStderrEnd)
    child.stderr?.off('close', onStderrEnd)
    child.stderr?.destroy()
    try {
      recordExit({
        verdict: 'exited',
        ...pendingExit,
        stderrTail: stderrTail.toString('utf8').trim()
      })
    } catch {
      // Diagnostics must never escape daemon lifecycle handling.
    }
  }
  const onStderrEnd = (): void => {
    stderrEnded = true
    finalizeExit()
  }
  const onProcessExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (stopped || !ready) {
      return
    }
    pendingExit = { exitCode, signal }
    if (stderrEnded) {
      finalizeExit()
      return
    }
    drainTimer = setTimeout(finalizeExit, STDERR_EXIT_DRAIN_MS)
    drainTimer.unref?.()
  }

  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  child.stderr?.on('end', onStderrEnd)
  child.stderr?.on('close', onStderrEnd)

  return {
    startupStderrTail(): string {
      return stderrTail.toString('utf8').trim()
    },
    markReady(): void {
      if (ready || stopped) {
        return
      }
      ready = true
      child.stderr?.unref?.()
      child.on('exit', onProcessExit)
    },
    stop(options = {}): void {
      if (stopped) {
        return
      }
      stopped = true
      if (drainTimer) {
        clearTimeout(drainTimer)
      }
      child.off('exit', onProcessExit)
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
      child.stderr?.off('end', onStderrEnd)
      child.stderr?.off('close', onStderrEnd)
      if (options.destroyStderr) {
        child.stderr?.destroy()
      }
    }
  }
}
