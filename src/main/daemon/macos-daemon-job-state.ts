import { runProcess } from '../../shared/child-process/run-process'

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
    // Only the job's top-level state; nested resource-pressure states say nothing about its process.
    const state = /^\tstate = (.+)$/m.exec(result.stdout)?.[1]
    return state === 'running' ? 'running' : state === 'not running' ? 'stopped' : 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}

export async function stopMacDaemonJob(service: string): Promise<void> {
  const result = await runProcess({
    program: '/bin/launchctl',
    args: ['bootout', service],
    timeoutMs: 10_000,
    maxOutputBytes: 8192
  })
  if (result.code === 0 && !result.timedOut) {
    return
  }
  if ((await readMacDaemonJobState(service)) !== 'missing') {
    throw new Error('Could not stop the macOS terminal service')
  }
}
