import { runProcess } from '@orca/process-host'
import { spawnDetachedWithoutInheritance } from '@orca/process-host/isolated-detached-spawn'
import { isAppKitSceneSelfDeadlockSample } from './appkit-scene-self-deadlock'

const SAMPLE_TIMEOUT_MS = 30_000

async function sampleProcess(pid: number): Promise<string | null> {
  try {
    const result = await runProcess({
      program: '/usr/bin/sample',
      args: [String(pid), '1', '-mayDie', '-file', '/dev/stdout'],
      timeoutMs: SAMPLE_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? result.stdout : null
  } catch {
    return null
  }
}

// Relaunches only after two samples prove the self-wait; a stall that merely blocks on I/O never matches.
export async function relaunchIfAppKitSceneDeadlocked(options: {
  parentPid: number
  bundlePath: string
  confirmDelayMs: number
  isStillHung: () => boolean
  onConfirmed: () => void
}): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, options.confirmDelayMs)
      await promise
    }
    if (!options.isStillHung()) {
      return false
    }
    const report = await sampleProcess(options.parentPid)
    if (!report || !isAppKitSceneSelfDeadlockSample(report) || !options.isStillHung()) {
      return false
    }
  }
  try {
    spawnDetachedWithoutInheritance({
      program: '/bin/sh',
      args: [
        '-c',
        'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$2"',
        'orca-hang-relaunch',
        String(options.parentPid),
        options.bundlePath
      ]
    }).unref()
    options.onConfirmed()
    process.kill(options.parentPid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}
