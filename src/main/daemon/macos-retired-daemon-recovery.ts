import { lstat } from 'node:fs/promises'
import { getAppEnvironment } from '../../shared/app-environment'
import { captureDescendantSnapshot } from '../pty-descendant-termination'
import { endpointIsProvenDead, probeSocketConnect } from './daemon-endpoint-probe'
import { getPsProcessIdentityAsync } from './daemon-process-identity-query'
import { hasErrorCode, inspectProcessLiveness } from './daemon-process-inspection'
import { releaseMacDaemonJob } from './macos-daemon-job-state'
import {
  listMacDaemonJobVersions,
  readMacDaemonRecoveryJob,
  type RetiredMacDaemonJob
} from './macos-retired-daemon-jobs'
import { terminateShutdownDescendants } from './terminal-descendant-shutdown'

async function pidRecordWasRetired(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
  }
}

async function endpointWasRetired(job: RetiredMacDaemonJob): Promise<boolean> {
  return (
    (await pidRecordWasRetired(job.pidPath)) &&
    endpointIsProvenDead(await probeSocketConnect(job.socketPath))
  )
}

async function sameJob(
  job: RetiredMacDaemonJob,
  userDataPath: string,
  runtimeDir: string
): Promise<boolean> {
  const current = await readMacDaemonRecoveryJob(userDataPath, runtimeDir, job.protocolVersion)
  return current?.pid === job.pid && current.launchNonce === job.launchNonce
}

async function recoverJob(
  job: RetiredMacDaemonJob,
  userDataPath: string,
  runtimeDir: string
): Promise<boolean> {
  if (!(await endpointWasRetired(job))) {
    return false
  }
  const identity = await getPsProcessIdentityAsync(job.pid)
  // A newly bootstrapping service may not have published yet; it is never a recovery target.
  if (!identity?.startedAtMs || Date.now() - identity.startedAtMs < 10_000) {
    return false
  }
  if (!(await sameJob(job, userDataPath, runtimeDir))) {
    return false
  }
  const beforeCapture = await getPsProcessIdentityAsync(job.pid)
  if (beforeCapture?.startedAtMs !== identity.startedAtMs) {
    return false
  }
  // Capture before signalling; let the daemon reap children while their exits are verified.
  const snapshot = await captureDescendantSnapshot(job.pid)
  if (
    !snapshot?.root ||
    Date.parse(snapshot.root.startedAt) !== identity.startedAtMs ||
    !(await sameJob(job, userDataPath, runtimeDir)) ||
    !(await endpointWasRetired(job))
  ) {
    throw new Error('Could not verify the retired macOS terminal service for recovery')
  }
  const verdict = await terminateShutdownDescendants(snapshot)
  if (verdict !== 'exited') {
    throw new Error(`Retired macOS terminal service descendants are ${verdict}`)
  }
  const remaining = await getPsProcessIdentityAsync(job.pid)
  if (remaining?.startedAtMs === identity.startedAtMs) {
    try {
      process.kill(job.pid, 'SIGKILL')
    } catch (error) {
      if (!hasErrorCode(error, 'ESRCH')) {
        throw error
      }
    }
  } else if (inspectProcessLiveness(job.pid).status !== 'exited') {
    throw new Error('Retired macOS terminal service changed during recovery')
  }
  if (!(await releaseMacDaemonJob(job.service, Date.now() + 3_000))) {
    throw new Error('Could not release the retired macOS terminal service registration')
  }
  console.info(
    `[daemon] Recovered retired macOS terminal service protocol=${job.protocolVersion} pid=${job.pid} descendants=${snapshot.descendants.length}`
  )
  return true
}

/**
 * Releases one label held by a service that retired its endpoint and PID record but never exited.
 * False leaves the job alone: it is live, unverifiable, still starting, or not this endpoint's.
 */
export async function recoverRetiredMacDaemonJob(
  userDataPath: string,
  runtimeDir: string,
  protocolVersion: number
): Promise<boolean> {
  const job = await readMacDaemonRecoveryJob(userDataPath, runtimeDir, protocolVersion)
  return job ? recoverJob(job, userDataPath, runtimeDir) : false
}

/** Explicit Restart only: healthy legacy daemons and newer app protocols retain their sessions. */
export async function recoverRetiredMacDaemonJobs(runtimeDir: string): Promise<void> {
  if (
    process.platform !== 'darwin' ||
    process.type !== 'browser' ||
    !getAppEnvironment().isPackaged()
  ) {
    return
  }
  const userDataPath = getAppEnvironment().getPath('userData')
  for (const version of await listMacDaemonJobVersions(userDataPath)) {
    const job = await readMacDaemonRecoveryJob(userDataPath, runtimeDir, version)
    if (job) {
      await recoverJob(job, userDataPath, runtimeDir)
    }
  }
}
