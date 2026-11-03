import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { runProcess } from '@orca/process-host'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import {
  allowsRealtimePriority,
  readZeroRtTimeLimit,
  setStartupRtPrioOutcome,
  type RtPrioOutcome
} from '../linux-rttime-limit'

// Why: complete=false when a live thread's children list is unreadable (e.g. a kernel without
// CONFIG_PROC_CHILDREN), so the breadcrumb never claims zygotes were lowered that were never seen.
export function listProcessTree(
  rootPid: number,
  procRoot = '/proc'
): { pids: number[]; complete: boolean } {
  const pids = [rootPid]
  let complete = true
  for (let i = 0; i < pids.length; i++) {
    let tids: string[]
    try {
      tids = readdirSync(`${procRoot}/${pids[i]}/task`)
    } catch {
      // The process exited, so it has nothing left to lower.
      continue
    }
    for (const tid of tids) {
      try {
        const children = readFileSync(`${procRoot}/${pids[i]}/task/${tid}/children`, 'utf8')
        pids.push(...children.split(/\s+/).filter(Boolean).map(Number))
      } catch {
        // A thread that exited between readdir and read is fine; a live unreadable one is not.
        if (existsSync(`${procRoot}/${pids[i]}/task/${tid}`)) {
          complete = false
        }
      }
    }
  }
  return { pids, complete }
}

async function lowerRealtimePriorityToZero(pids: number[], procRoot: string): Promise<boolean> {
  const results = await Promise.all(
    pids.map((pid) =>
      runProcess({
        program: 'prlimit',
        args: ['--pid', String(pid), '--rtprio=0:0'],
        stdio: 'ignore',
        timeoutMs: 2000
      }).then(
        (result) => result.code === 0,
        () => false
      )
    )
  )
  // Why: a short-lived helper that exited after the walk has nothing left to lower, so its
  // failed prlimit must not make the breadcrumb say the live tree wasn't lowered.
  return results.every((ok, i) => ok || !existsSync(`${procRoot}/${pids[i]}`))
}

/**
 * Why: Chromium makes audio threads SCHED_RR whenever RLIMIT_RTPRIO allows, and under a zero
 * RLIMIT_RTTIME the first RT watchdog tick SIGKILLs that renderer/audio process. Zeroing RTPRIO
 * makes Chromium fall back to a nice value. Zygotes already exist and later renderers fork from
 * them, so the whole current tree is lowered; callers await this before the first window.
 * Only covers RTPRIO > 0; zero-RTTIME kills with RTPRIO 0 have another trigger. Never rejects.
 */
export async function refuseRealtimeSchedulingUnderZeroRtTime(
  platform: NodeJS.Platform = process.platform,
  limitsPath = '/proc/self/limits',
  procRoot = '/proc'
): Promise<void> {
  const rtTime = readZeroRtTimeLimit(platform, limitsPath)
  if (!rtTime) {
    return
  }
  let rtPrio: RtPrioOutcome = 'not-needed'
  if (allowsRealtimePriority(platform, limitsPath)) {
    const tree = listProcessTree(process.pid, procRoot)
    if (!(await lowerRealtimePriorityToZero(tree.pids, procRoot))) {
      rtPrio = 'prlimit-failed'
    } else {
      rtPrio = tree.complete ? 'lowered' : 'lowered-partial-tree'
    }
  }
  setStartupRtPrioOutcome(rtPrio)
  recordCrashBreadcrumb('linux_rttime_limit', { ...rtTime, rtPrio })
}
