import { setTimeout as wait } from 'node:timers/promises'
import { PTY_SESSION_VERIFY_TIMEOUT_MS } from '../shared/terminal-teardown-timeouts'
import { isEmptyProcessSelection, type PtySessionCommandRunner } from './pty-session-membership'

export type PtyProcessSignaler = (pid: number, signal: NodeJS.Signals | 0) => void

const VERIFY_PID_BATCH_SIZE = 64
const VERIFY_POLL_INITIAL_MS = 10
const VERIFY_POLL_MAX_MS = 100

export async function verifyProcessesStopped(
  pids: number[],
  run: PtySessionCommandRunner,
  killProcess: PtyProcessSignaler
): Promise<boolean> {
  const verificationDeadline = Date.now() + PTY_SESSION_VERIFY_TIMEOUT_MS
  let pending = pids
  let pollDelayMs = VERIFY_POLL_INITIAL_MS
  let yieldedForReaping = false
  let useFastAbsenceProbe = true
  while (pending.length > 0) {
    let present = pending
    if (useFastAbsenceProbe) {
      present = []
      for (const pid of pending) {
        try {
          // Why: the common SIGKILL path reaps quickly. Two signal-0 absence
          // probes avoid spawning slow BSD ps, then batched ps owns later polls.
          killProcess(pid, 0)
          present.push(pid)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            return false
          }
        }
      }
      if (present.length === 0) {
        return true
      }
    }
    if (!yieldedForReaping) {
      const remainingMs = verificationDeadline - Date.now()
      const waitMs = Math.min(VERIFY_POLL_INITIAL_MS, remainingMs - 1)
      if (waitMs <= 0) {
        return false
      }
      // Why: node-pty reaps its child on the next event-loop turn. Give that
      // callback one chance before invoking comparatively slow BSD ps.
      await wait(waitMs)
      yieldedForReaping = true
      continue
    }
    useFastAbsenceProbe = false
    const nextPending: number[] = []
    for (let index = 0; index < present.length; index += VERIFY_PID_BATCH_SIZE) {
      const remainingMs = verificationDeadline - Date.now()
      if (remainingMs <= 0) {
        return false
      }
      const batch = present.slice(index, index + VERIFY_PID_BATCH_SIZE)
      try {
        const result = (await run('ps', ['-p', batch.join(','), '-o', 'pid=', '-o', 'stat='], {
          timeout: remainingMs
        })) as { stdout?: string | Buffer }
        const livePids = readLiveProcessIds(result.stdout, batch)
        if (!livePids) {
          return false
        }
        nextPending.push(...livePids)
      } catch (error) {
        if (!isEmptyProcessSelection(error)) {
          return false
        }
      }
    }
    pending = nextPending
    if (pending.length === 0) {
      return true
    }
    const remainingMs = verificationDeadline - Date.now()
    if (remainingMs <= 0) {
      return false
    }
    // Why: signal delivery and process reaping are asynchronous. Back off the
    // still-live subset so a stuck tree cannot spawn ps every 10ms at scale.
    const waitMs = Math.min(pollDelayMs, remainingMs - 1)
    if (waitMs <= 0) {
      return false
    }
    await wait(waitMs)
    pollDelayMs = Math.min(pollDelayMs * 2, VERIFY_POLL_MAX_MS)
  }
  return true
}

function readLiveProcessIds(
  stdout: string | Buffer | undefined,
  expectedPids: readonly number[]
): number[] | null {
  const expected = new Set(expectedPids)
  const seen = new Set<number>()
  const livePids: number[] = []
  const lines = String(stdout ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    const columns = line.split(/\s+/)
    const [pidText, status] = columns
    // Why: numeric coercion accepts signs, decimals, and exponents; process
    // verification must accept only the canonical PID text emitted by ps.
    if (columns.length !== 2 || !pidText || !/^[1-9]\d*$/.test(pidText)) {
      return null
    }
    const pid = Number(pidText)
    if (!Number.isSafeInteger(pid) || !expected.has(pid) || seen.has(pid) || !status) {
      return null
    }
    seen.add(pid)
    if (!status.startsWith('Z')) {
      livePids.push(pid)
    }
  }
  return livePids
}
