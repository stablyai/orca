import { spawnProcess } from '../../shared/child-process/run-process'
import { mapSimctlError } from './simctl-simulator-devices'
import { parseSimulatorLogLine, simctlLogShowArgs, type SimulatorLogEntry } from './simctl-log'

const SIMULATOR_LOG_TIMEOUT_MS = 20_000
const SIMULATOR_LOG_EXIT_GRACE_MS = 2_000
const SIMULATOR_LOG_STDERR_LIMIT = 64 * 1024

const ignoreLateError = (): void => {}

/**
 * Streams simulator logs while retaining only the newest requested entries.
 * @param udid Simulator device identifier.
 * @param options Line limit, predicates, and query window.
 * @returns Normalized entries ordered from oldest to newest.
 */
export function captureSimulatorLog(
  udid: string,
  options?: { lines?: number; filters?: readonly string[]; window?: string }
): Promise<SimulatorLogEntry[]> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess({
      program: 'xcrun',
      args: simctlLogShowArgs(udid, { filters: options?.filters, window: options?.window }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const entries: SimulatorLogEntry[] = []
    const lineLimit = options?.lines
    let nextEntryIndex = 0
    let pending = ''
    let stderr = ''
    let settled = false
    let failure: Parameters<typeof mapSimctlError>[0] | undefined
    let exited = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const appendEntry = (line: string): void => {
      const entry = parseSimulatorLogLine(line)
      if (!entry) {
        return
      }
      if (lineLimit !== undefined && lineLimit <= 0) {
        return
      }
      if (lineLimit === undefined || entries.length < lineLimit) {
        entries.push(entry)
        return
      }
      entries[nextEntryIndex] = entry
      nextEntryIndex = (nextEntryIndex + 1) % lineLimit
    }

    const onStdout = (chunk: string): void => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        appendEntry(line)
      }
    }
    const onStderr = (chunk: string): void => {
      stderr = `${stderr}${chunk}`.slice(-SIMULATOR_LOG_STDERR_LIMIT)
    }
    const settle = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      clearTimeout(graceTimer)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      // Late pipe/process errors must remain handled without retaining capture buffers.
      for (const emitter of [child, child.stdout, child.stderr]) {
        emitter.on('error', ignoreLateError)
        emitter.removeListener('error', onError)
      }
      if (failure) {
        child.stdout.destroy()
        child.stderr.destroy()
        reject(mapSimctlError(failure, stderr))
        return
      }
      appendEntry(pending)
      resolve(
        nextEntryIndex === 0
          ? entries
          : [...entries.slice(nextEntryIndex), ...entries.slice(0, nextEntryIndex)]
      )
    }
    const signalChild = (signal: NodeJS.Signals): void => {
      if (settled || exited || child.exitCode != null || child.signalCode != null) {
        return
      }
      try {
        child.kill(signal)
      } catch {
        // Failed signalling cannot extend the settlement deadline or replace the cause.
      }
    }
    const onError = (error: Parameters<typeof mapSimctlError>[0]): void => {
      if (settled || failure) {
        return
      }
      failure = error
      clearTimeout(timeout)
      child.stdout.removeListener('data', onStdout)
      pending = ''
      entries.length = 0
      if (child.pid == null && error.code === 'ENOENT') {
        settle()
        return
      }
      // Arm before signalling: kill can synchronously emit error or close.
      graceTimer = setTimeout(() => {
        signalChild('SIGKILL')
        settle()
      }, SIMULATOR_LOG_EXIT_GRACE_MS)
      signalChild('SIGTERM')
    }
    const onExit = (): void => {
      exited = true
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      exited = true
      if (!failure && code !== 0) {
        failure = Object.assign(
          new Error(
            `xcrun simctl log show exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`
          ),
          { code }
        )
      }
      settle()
    }

    child.on('error', onError)
    child.stdout.on('error', onError)
    child.stderr.on('error', onError)
    child.on('exit', onExit)
    child.on('close', onClose)
    timeout = setTimeout(() => {
      onError(new Error(`xcrun simctl log show timed out after ${SIMULATOR_LOG_TIMEOUT_MS}ms`))
    }, SIMULATOR_LOG_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
  })
}
