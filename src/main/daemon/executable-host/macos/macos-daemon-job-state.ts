import { setTimeout as delay } from 'node:timers/promises'
import { runProcess } from '@orca/process-host'

const JOB_REMOVAL_TIMEOUT_MS = 3_000
const JOB_REMOVAL_POLL_MS = 50
const JOB_RETIREMENT_POLL_MS = 250

export type MacDaemonJobState = 'running' | 'stopped' | 'missing' | 'unverifiable'

export async function readMacDaemonJobState(service: string): Promise<MacDaemonJobState> {
  try {
    const result = await runProcess({
      program: '/bin/launchctl',
      args: ['print', service],
      timeoutMs: 3_000,
      maxOutputBytes: 128 * 1024
    })
    if (result.timedOut || result.outputTruncated) {
      return 'unverifiable'
    }
    if (
      result.code === 113 &&
      result.stderr.includes('Could not find service') &&
      !/Operation not permitted|Permission denied/i.test(result.stderr)
    ) {
      return 'missing'
    }
    if (result.code !== 0) {
      return 'unverifiable'
    }
    // Nested resource-pressure states do not describe the job’s process.
    const state = /^\tstate = (.+)$/m.exec(result.stdout)?.[1]
    return state === 'running' ? 'running' : state === 'not running' ? 'stopped' : 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}

export async function stopMacDaemonJob(service: string): Promise<void> {
  await runProcess({
    program: '/bin/launchctl',
    args: ['bootout', service],
    timeoutMs: 10_000,
    maxOutputBytes: 8192
  })
  // bootout can return before launchd releases the label for bootstrap.
  const goneByMs = Date.now() + JOB_REMOVAL_TIMEOUT_MS
  while ((await readMacDaemonJobState(service)) !== 'missing') {
    if (Date.now() >= goneByMs) {
      throw new Error('Could not stop the macOS terminal service')
    }
    await delay(JOB_REMOVAL_POLL_MS)
  }
}

/** Release only missing or confirmed-stopped jobs so no process can still start under this label. */
export async function releaseMacDaemonJob(
  service: string,
  waitUntilMs = Date.now()
): Promise<boolean> {
  let state = await readMacDaemonJobState(service)
  // Endpoint retirement can precede process exit; never boot out a running or unreadable job.
  while (state === 'running' && Date.now() < waitUntilMs) {
    await delay(Math.max(1, Math.min(JOB_RETIREMENT_POLL_MS, waitUntilMs - Date.now())))
    state = await readMacDaemonJobState(service)
  }
  if (state !== 'stopped') {
    return state === 'missing'
  }
  return stopMacDaemonJob(service).then(
    () => true,
    () => false
  )
}
