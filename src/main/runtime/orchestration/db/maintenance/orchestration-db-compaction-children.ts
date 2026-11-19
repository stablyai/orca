import { spawnProcess } from '@orca/process-host'
import { compactionChildSource } from './orchestration-db-compaction-child-source'
import type { OrchestrationDbCompaction } from './orchestration-db-compaction'

/** Runs the child for one job only, stopped at `ms`; resolves when it has exited or at `ms`. */
export function runChild(filename: string, job: { recoverOnly: true }, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProcess>
    try {
      child = spawnProcess({
        program: process.execPath,
        args: ['-e', compactionChildSource],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ORCA_ORCHESTRATION_COMPACTION: JSON.stringify({ filename, ...job })
        },
        stdio: 'ignore'
      })
    } catch {
      resolve()
      return
    }
    const stop = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, ms)
    const done = (): void => {
      clearTimeout(stop)
      resolve()
    }
    child.once('error', done)
    child.once('close', done)
  })
}

function readChildResult(output: string): OrchestrationDbCompaction | null {
  try {
    const parsed: unknown = JSON.parse(output.trim().split('\n').at(-1) ?? '')
    return typeof parsed === 'object' && parsed !== null && 'kind' in parsed
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by compactionChildSource above.
        (parsed as OrchestrationDbCompaction)
      : null
  } catch {
    return null
  }
}

export function runCompactionChild({
  filename,
  budgetMs,
  graceMs,
  release,
  started,
  job
}: {
  filename: string
  budgetMs: number
  graceMs: number
  release: () => void
  started: number
  job: Record<string, unknown>
}): Promise<{ result: OrchestrationDbCompaction; heldLock: boolean }> {
  let heldLock = false
  return new Promise((settle) => {
    const resolve = (result: OrchestrationDbCompaction): void => settle({ result, heldLock })
    let child: ReturnType<typeof spawnProcess>
    try {
      child = spawnProcess({
        program: process.execPath,
        args: ['-e', compactionChildSource],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ORCA_ORCHESTRATION_COMPACTION: JSON.stringify({ filename, ...job })
        },
        stdio: 'pipe'
      })
    } catch (error) {
      resolve({ kind: 'failed', error: String(error) })
      return
    }
    // A child gone before it reads 'go' makes that write fail; at quit that must never be unhandled.
    child.stdin?.on('error', () => {})
    let output = ''
    let released = false
    let timedOut = false
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      heldLock ||= output.startsWith('ready\nlocked\n')
      if (!released && output.startsWith('ready\n')) {
        released = true
        // A stopped child can't take over; the WAL cap bounds the close if it died unseen.
        if (timedOut || child.exitCode !== null || child.signalCode !== null) {
          return
        }
        try {
          release()
          child.stdin?.end('go\n')
        } catch (error) {
          child.kill('SIGKILL')
          finish({ kind: 'failed', error: String(error) })
        }
      }
    })
    let grace: NodeJS.Timeout | undefined
    const finish = (result: OrchestrationDbCompaction): void => {
      clearTimeout(budget)
      clearTimeout(grace)
      resolve(result)
    }
    // Killing it rolls the VACUUM back; quit then waits briefly for the lock to drop, never longer.
    const budget = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      grace = setTimeout(
        () => finish({ kind: 'timed-out', ms: Math.round(performance.now() - started) }),
        graceMs
      )
    }, budgetMs)
    child.once('error', (error) => finish({ kind: 'failed', error: String(error) }))
    child.once('close', () =>
      finish(
        timedOut
          ? { kind: 'timed-out', ms: Math.round(performance.now() - started) }
          : (readChildResult(output) ?? { kind: 'failed', error: 'no result from compaction' })
      )
    )
  })
}
