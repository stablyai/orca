import { spawn } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { mapSimctlError } from './simctl-simulator-devices'
import { parseSimulatorLogLine, simctlLogShowArgs, type SimulatorLogEntry } from './simctl-log'

const SIMULATOR_LOG_TIMEOUT_MS = 20_000
const SIMULATOR_LOG_STDERR_LIMIT = 64 * 1024

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
    const child = spawn(
      'xcrun',
      simctlLogShowArgs(udid, { filters: options?.filters, window: options?.window }),
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const entries: SimulatorLogEntry[] = []
    const lineLimit = options?.lines
    let nextEntryIndex = 0
    let pending = ''
    let stderr = ''
    let settled = false
    let timedOut = false

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

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        appendEntry(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-SIMULATOR_LOG_STDERR_LIMIT)
    })

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, SIMULATOR_LOG_TIMEOUT_MS)

    child.once('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(mapSimctlError(error as ExecFileException, stderr))
    })
    child.once('close', (code, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      appendEntry(pending)
      if (timedOut || code !== 0) {
        const detail = timedOut
          ? `xcrun simctl log show timed out after ${SIMULATOR_LOG_TIMEOUT_MS}ms`
          : `xcrun simctl log show exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`
        reject(mapSimctlError(Object.assign(new Error(detail), { code }), stderr))
        return
      }
      resolve(
        nextEntryIndex === 0
          ? entries
          : [...entries.slice(nextEntryIndex), ...entries.slice(0, nextEntryIndex)]
      )
    })
  })
}
