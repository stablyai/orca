import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getAppEnvironment } from '../../shared/app-environment'
import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from '../../shared/local-build-compatibility-contract'
import { NODE_RUNTIME_DARWIN_MINIMUM_OS } from '../../shared/node-runtime-pin'
import { runProcess } from '@orca/process-host'
import { rm } from '../asar-transparent-fs'
import { compareDottedVersions } from '../orcad/native-host-abi'
import { DaemonClient } from './client'
import { DaemonEndpointOwnershipError, holdDaemonAdoptionLease } from './daemon-endpoint-adoption'
import { buildDaemonScriptArgs, type DaemonChildSpawnOptions } from './daemon-launched-child-spawn'
import { macDaemonJobLabel } from './macos-daemon-job-label'
import type { DaemonProcessHandle } from './daemon-spawner'
import { DAEMON_SHUTDOWN_TIMEOUT_MS } from './daemon-shutdown-deadline'
import {
  getMacDaemonBundleRoot,
  materializeMacDaemonBundle,
  type MacDaemonBundle
} from './macos-daemon-bundle'
import {
  retireOtherMacDaemonCopies,
  retireUnusedMacDaemonCopy
} from './macos-daemon-bundle-retirement'
import {
  releaseMacDaemonJob,
  readMacDaemonJobState,
  stopMacDaemonJob
} from './macos-daemon-job-state'
import { recoverRetiredMacDaemonJob } from './macos-retired-daemon-recovery'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

type MacDaemonLaunchOptions = Omit<
  DaemonChildSpawnOptions,
  'forkEntryPath' | 'relocatedExecPath'
> & {
  runtimeDir: string
}

export type MacStableLaunchFallbackReason =
  | 'prepare-failed'
  | 'deadline'
  | 'bootstrap-refused'
  | 'exited-before-ready'
  | 'endpoint-taken'

const BOOTSTRAP_TIMEOUT_MS = 10_000
const STARTUP_TIMEOUT_MS = 10_000
const JOB_CHECK_INTERVAL_MS = 250

export { macDaemonJobLabel } from './macos-daemon-job-label'

function buildMacDaemonLaunchJob(
  options: MacDaemonLaunchOptions,
  bundle: MacDaemonBundle,
  label: string
): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env, ORCA_USER_DATA_PATH: options.userDataPath }
  // Plain Node does not use Electron’s Node-mode switch or inherited IPC descriptors.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_CHANNEL_FD
  delete env.NODE_CHANNEL_SERIALIZATION_MODE
  delete env.NODE_UNIQUE_ID
  return {
    Label: label,
    ProgramArguments: [
      bundle.execPath,
      bundle.entryPath,
      ...buildDaemonScriptArgs(options, bundle.execPath)
    ],
    EnvironmentVariables: env,
    WorkingDirectory: options.userDataPath,
    RunAtLoad: true,
    KeepAlive: false,
    AbandonProcessGroup: true,
    // Associate plist-launched jobs with Orca for Local Network access.
    AssociatedBundleIdentifiers: [LOCAL_BUILD_COMPATIBILITY_CONTRACT.appId],
    ProcessType: 'Interactive',
    // launchd disables cloud-file downloads for jobs unless asked; shells need them like Terminal.app.
    MaterializeDatalessFiles: true,
    StandardOutPath: '/dev/null',
    StandardErrorPath: '/dev/null'
  }
}

/** Permit fork fallback only before the handoff deadline. */
function fallBackToFork(
  reason: MacStableLaunchFallbackReason,
  error: unknown,
  deadlineMs: number
): null {
  if (Date.now() > deadlineMs) {
    throw error
  }
  console.warn(
    `[daemon] macOS terminal host fallback reason=${reason}; forking from the app`,
    error
  )
  return null
}

/** Recover a verified retired service whose occupied label blocks every new launch. */
async function recoverBlockingMacDaemonJob(options: MacDaemonLaunchOptions): Promise<boolean> {
  try {
    return await recoverRetiredMacDaemonJob(
      options.userDataPath,
      options.runtimeDir,
      PROTOCOL_VERSION
    )
  } catch (error) {
    console.warn('[daemon] Could not recover the earlier macOS terminal service', error)
    return false
  }
}

/** Use a signed launchd helper to survive app updates; null permits safe fork fallback. */
export async function launchMacDaemonFromStableBundle(
  options: MacDaemonLaunchOptions,
  deadlineMs: number
): Promise<DaemonProcessHandle | null> {
  // GUI login-session watching excludes serve mode.
  if (
    process.platform !== 'darwin' ||
    !options.macosLoginSessionWatch ||
    !getAppEnvironment().isPackaged()
  ) {
    return null
  }
  // Older Macs need the fork path because the helper’s Node cannot load there.
  const systemVersion = process.getSystemVersion?.()
  if (!systemVersion || compareDottedVersions(systemVersion, NODE_RUNTIME_DARWIN_MINIMUM_OS) < 0) {
    return null
  }
  const label = macDaemonJobLabel(options.userDataPath)
  const domain = `gui/${process.getuid?.()}`
  const service = `${domain}/${label}`
  // Reserve time after preparation for bootstrap and readiness.
  const remainingMs = deadlineMs - BOOTSTRAP_TIMEOUT_MS - STARTUP_TIMEOUT_MS - Date.now()
  const prepareSignal = remainingMs > 0 ? AbortSignal.timeout(remainingMs) : AbortSignal.abort()
  const root = getMacDaemonBundleRoot(options.userDataPath)
  let bundle: MacDaemonBundle
  try {
    bundle = await materializeMacDaemonBundle(root, prepareSignal)
  } catch (error) {
    return fallBackToFork(prepareSignal.aborted ? 'deadline' : 'prepare-failed', error, deadlineMs)
  }
  void retireOtherMacDaemonCopies(root, bundle.directory)
  // Permit fallback only after proving this job cannot start.
  const abandon = async (reason: MacStableLaunchFallbackReason, error: unknown): Promise<null> => {
    if (!(await releaseMacDaemonJob(service))) {
      throw error
    }
    void retireUnusedMacDaemonCopy(bundle.directory)
    return fallBackToFork(reason, error, deadlineMs)
  }

  // Old-job retirement must leave enough time for bootstrap and readiness.
  const releaseByMs = Math.min(
    Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS + 2_000,
    deadlineMs - BOOTSTRAP_TIMEOUT_MS - STARTUP_TIMEOUT_MS
  )
  if (
    !(await releaseMacDaemonJob(service, releaseByMs)) &&
    !(await recoverBlockingMacDaemonJob(options))
  ) {
    throw new Error(
      'A macOS terminal service from an earlier launch is still registered. Restart terminals from Settings → Manage Sessions.'
    )
  }
  // Remove the plist after bootstrap because its inherited environment may contain credentials.
  const jobPath = join(bundle.directory, `launch-${options.launchNonce}.plist`)
  const removeJobFile = (): Promise<void> => rm(jobPath, { force: true }).catch(() => {})
  try {
    await writeFile(jobPath, JSON.stringify(buildMacDaemonLaunchJob(options, bundle, label)), {
      mode: 0o600,
      flag: 'wx'
    })
    const converted = await runProcess({
      program: '/usr/bin/plutil',
      args: ['-convert', 'xml1', jobPath],
      timeoutMs: 5_000,
      maxOutputBytes: 8192,
      signal: prepareSignal
    })
    if (converted.code !== 0 || converted.timedOut) {
      throw new Error('Could not write the macOS terminal service job')
    }
  } catch (error) {
    await removeJobFile()
    return fallBackToFork(prepareSignal.aborted ? 'deadline' : 'prepare-failed', error, deadlineMs)
  }
  // Do not inherit the preparation abort signal: interrupted bootstrap leaves job ownership unknown.
  const bootstrap = await runProcess({
    program: '/bin/launchctl',
    args: ['bootstrap', domain, jobPath],
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    maxOutputBytes: 8192
  }).finally(removeJobFile)
  if (bootstrap.timedOut) {
    throw new Error('Could not start the macOS terminal service')
  }
  if (bootstrap.code !== 0) {
    return await abandon('bootstrap-refused', new Error('launchd refused the terminal service'))
  }

  const client = new DaemonClient({ socketPath: options.socketPath, tokenPath: options.tokenPath })
  const readyByMs = Date.now() + STARTUP_TIMEOUT_MS
  for (;;) {
    try {
      await client.ensureConnectedWithin(Math.max(1, readyByMs - Date.now()))
      break
    } catch (error) {
      client.disconnect()
      // A helper refused at exec cannot answer; fall back once its job stops.
      const state = await readMacDaemonJobState(service)
      if (state === 'stopped' || state === 'missing' || Date.now() >= readyByMs) {
        return await abandon('exited-before-ready', error)
      }
      await delay(JOB_CHECK_INTERVAL_MS)
    }
  }
  if (client.getDaemonIdentity()?.launchNonce !== options.launchNonce) {
    client.disconnect()
    // Let the fork launcher adopt the competing endpoint normally.
    await stopMacDaemonJob(service)
    const error = new DaemonEndpointOwnershipError('Another daemon owns the terminal endpoint')
    return fallBackToFork('endpoint-taken', error, deadlineMs)
  }
  return await holdDaemonAdoptionLease(
    { shutdown: () => stopMacDaemonJob(service) },
    {
      socketPath: options.socketPath,
      tokenPath: options.tokenPath,
      pidPath: options.pidPath,
      connectedClient: client
    }
  )
}
