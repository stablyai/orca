import type { ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { spawnProcess } from '@orca/process-host'
import { compactionChildSource } from './orchestration-db-compaction-child-source'

export type CompactionChild = Pick<ChildProcess, 'kill'>

/**
 * Starts the compaction child: with a target it writes the copy and is stopped as soon as `isStale` says a
 * commit made it useless; without, it only drains the WAL, and truncates it when asked. Resolves true on a
 * clean exit: the copy written, or every WAL frame drained.
 */
export function runCompactionChild(job: {
  filename: string
  target: string | undefined
  truncate?: boolean
  budgetMs: number
  isStale: () => boolean
}): { child: CompactionChild | undefined; done: Promise<boolean> } {
  let child: ChildProcess
  try {
    child = spawnProcess({
      program: process.execPath,
      args: ['-e', compactionChildSource],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ORCA_ORCHESTRATION_COMPACTION: JSON.stringify({
          filename: job.filename,
          target: job.target,
          truncate: job.truncate === true,
          budgetMs: job.budgetMs
        })
      },
      // Never written: the child stops itself when this end closes, so it can't outlive a killed app.
      stdio: ['pipe', 'ignore', 'ignore']
    })
  } catch {
    return { child: undefined, done: Promise.resolve(false) }
  }
  const done = new Promise<boolean>((resolve) => {
    const budget = setTimeout(() => child.kill('SIGKILL'), job.budgetMs)
    // A write makes the copy stale, so stop it then: its disk traffic can slow the runtime's later
    // commits (seen on a busy Linux disk). Every commit touches the WAL; the stamp stays the judge.
    let walWatch: FSWatcher | undefined
    try {
      walWatch =
        job.target === undefined
          ? undefined
          : watch(`${job.filename}-wal`, () => {
              if (job.isStale()) {
                child.kill('SIGKILL')
              }
            })
      walWatch?.on('error', () => {
        walWatch?.close()
        child.kill('SIGKILL')
      })
    } catch {
      // Without events nothing could stop a copy a write made useless before it rewrote all the history.
      child.kill('SIGKILL')
    }
    // Any exit, update installs included: a child left running would hold the app's executable open.
    const killOnExit = (): void => {
      child.kill('SIGKILL')
    }
    process.once('exit', killOnExit)
    const settle = (copied: boolean): void => {
      clearTimeout(budget)
      walWatch?.close()
      process.off('exit', killOnExit)
      resolve(copied)
    }
    child.once('error', () => settle(false))
    child.once('close', (code) => settle(code === 0))
  })
  return { child, done }
}
