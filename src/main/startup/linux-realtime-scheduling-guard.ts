import { readdirSync, readFileSync } from 'node:fs'
import { runProcess } from '@orca/process-host'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { allowsRealtimePriority, readZeroRtTimeLimit } from '../linux-rttime-limit'

type RtPrioOutcome = 'lowered' | 'not-needed' | 'prlimit-failed'

function listProcessTree(rootPid: number): number[] {
  const pids = [rootPid]
  for (let i = 0; i < pids.length; i++) {
    let tids: string[]
    try {
      tids = readdirSync(`/proc/${pids[i]}/task`)
    } catch {
      continue
    }
    for (const tid of tids) {
      try {
        const children = readFileSync(`/proc/${pids[i]}/task/${tid}/children`, 'utf8')
        pids.push(...children.split(' ').filter(Boolean).map(Number))
      } catch {
        // The thread exited between readdir and read.
      }
    }
  }
  return pids
}

async function lowerRealtimePriorityToZero(pids: number[]): Promise<RtPrioOutcome> {
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
  return results.every(Boolean) ? 'lowered' : 'prlimit-failed'
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
  limitsPath = '/proc/self/limits'
): Promise<void> {
  const rtTime = readZeroRtTimeLimit(platform, limitsPath)
  if (!rtTime) {
    return
  }
  const rtPrio = allowsRealtimePriority(platform, limitsPath)
    ? await lowerRealtimePriorityToZero(listProcessTree(process.pid))
    : 'not-needed'
  recordCrashBreadcrumb('linux_rttime_limit', { ...rtTime, rtPrio })
}
