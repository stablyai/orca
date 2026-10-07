import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getAppEnvironment } from '../../shared/app-environment'
import { runProcess } from '../../shared/child-process/run-process'
import { DaemonClient } from './client'
import { DaemonEndpointOwnershipError, holdDaemonAdoptionLease } from './daemon-endpoint-adoption'
import { buildDaemonScriptArgs, type DaemonChildSpawnOptions } from './daemon-launched-child-spawn'
import { materializeMacDaemonBundle } from './macos-daemon-bundle'
import { rm as removeBundle } from '../asar-transparent-fs'
import {
  retireUnusedMacDaemonBundle,
  writeMacDaemonJobRecord
} from './macos-daemon-bundle-retirement'
import { readMacDaemonJobState, stopMacDaemonJob } from './macos-daemon-job-state'
import type { DaemonProcessHandle } from './daemon-spawner'

type MacDaemonLaunchOptions = Omit<DaemonChildSpawnOptions, 'forkEntryPath' | 'relocatedExecPath'>

const BOOTSTRAP_TIMEOUT_MS = 10_000
const STARTUP_TIMEOUT_MS = 10_000
const JOB_EXIT_CHECK_INTERVAL_MS = 500
/** Every packaged build's `appId` (`config/electron-builder.config.cjs`). */
const ORCA_BUNDLE_IDENTIFIER = 'com.stablyai.orca'

/** No job from this attempt can still claim the endpoint, so the app's own fork launcher may run. */
export class MacDaemonStableLaunchUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MacDaemonStableLaunchUnavailableError'
  }
}

function buildMacDaemonLaunchJob(
  options: MacDaemonLaunchOptions,
  execPath: string,
  entryPath: string,
  label: string
): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ORCA_USER_DATA_PATH: options.userDataPath
  }
  delete env.NODE_CHANNEL_FD
  delete env.NODE_CHANNEL_SERIALIZATION_MODE
  delete env.NODE_UNIQUE_ID
  return {
    Label: label,
    ProgramArguments: [execPath, entryPath, ...buildDaemonScriptArgs(options, execPath)],
    EnvironmentVariables: env,
    WorkingDirectory: options.userDataPath,
    RunAtLoad: true,
    KeepAlive: false,
    AbandonProcessGroup: true,
    // A plist job outside SMAppService names its app here so Local Network access resolves to Orca.
    AssociatedBundleIdentifiers: [ORCA_BUNDLE_IDENTIFIER],
    ProcessType: 'Interactive',
    StandardOutPath: '/dev/null',
    StandardErrorPath: '/dev/null'
  }
}

/** A launchd child owns Orca's signed identity independently of the replaceable UI process. */
export async function launchMacDaemonFromStableBundle(
  options: MacDaemonLaunchOptions,
  deadlineMs: number
): Promise<DaemonProcessHandle | null> {
  if (process.platform !== 'darwin' || !options.macosLoginSessionWatch) {
    return null
  }
  const environment = getAppEnvironment()
  if (!environment.isPackaged() || !environment.getAppPath().includes('app.asar')) {
    return null
  }
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new MacDaemonStableLaunchUnavailableError('Could not resolve the macOS login user')
  }
  const label = `com.stablyai.orca.terminal.${options.launchNonce}`
  const domain = `gui/${uid}`
  const service = `${domain}/${label}`
  // Preparation ends early enough for bootstrap and this job's readiness wait to meet the deadline.
  const prepareDeadlineMs = deadlineMs - BOOTSTRAP_TIMEOUT_MS - STARTUP_TIMEOUT_MS
  const remainingMs = prepareDeadlineMs - Date.now()
  const prepareSignal = remainingMs > 0 ? AbortSignal.timeout(remainingMs) : AbortSignal.abort()
  const bundle = await materializeMacDaemonBundle(
    options.userDataPath,
    options.entryPath,
    label,
    prepareSignal
  ).catch((error: unknown) => {
    throw new MacDaemonStableLaunchUnavailableError(
      prepareSignal.aborted
        ? 'The macOS terminal service startup deadline expired'
        : 'Could not prepare the macOS terminal runtime',
      { cause: error }
    )
  })
  const jobPath = join(bundle.directory, 'launch.plist')
  const shutdown = async (): Promise<void> => {
    await stopMacDaemonJob(service)
    await retireUnusedMacDaemonBundle(bundle.directory)
  }
  // Only a stopped or unregistered job proves no daemon from this attempt can appear later.
  const abandonUnlessLive = async (error: unknown): Promise<never> => {
    const state = await readMacDaemonJobState(service)
    if (state === 'stopped') {
      await stopMacDaemonJob(service).catch(() => {
        throw error
      })
    } else if (state !== 'missing') {
      throw error
    }
    void retireUnusedMacDaemonBundle(bundle.directory)
    throw new MacDaemonStableLaunchUnavailableError('The macOS terminal service did not start', {
      cause: error
    })
  }
  try {
    // The inherited environment can contain credentials; never leave it on disk after bootstrap.
    await writeFile(
      jobPath,
      JSON.stringify(buildMacDaemonLaunchJob(options, bundle.execPath, bundle.entryPath, label)),
      { mode: 0o600, flag: 'wx' }
    )
    const converted = await runProcess({
      program: '/usr/bin/plutil',
      args: ['-convert', 'xml1', jobPath],
      timeoutMs: 5_000,
      maxOutputBytes: 8192,
      signal: prepareSignal
    })
    if (converted.code !== 0 || converted.timedOut) {
      throw new Error('Could not prepare the macOS terminal service')
    }
    if (prepareSignal.aborted) {
      throw new Error('The macOS terminal service startup deadline expired')
    }
  } catch (error) {
    await rm(jobPath, { force: true }).catch(() => {})
    await removeBundle(bundle.directory, { recursive: true, force: true }).catch(() => {})
    throw new MacDaemonStableLaunchUnavailableError('Could not submit the macOS terminal service', {
      cause: error
    })
  }
  try {
    const result = await runProcess({
      program: '/bin/launchctl',
      args: ['bootstrap', domain, jobPath],
      timeoutMs: BOOTSTRAP_TIMEOUT_MS,
      maxOutputBytes: 8192
    })
    if (result.timedOut) {
      throw new Error('Could not start the macOS terminal service')
    }
    if (result.code !== 0) {
      await abandonUnlessLive(new Error('Could not start the macOS terminal service'))
    }
    await writeMacDaemonJobRecord(bundle.directory, label, true).catch(() => {})
  } finally {
    await rm(jobPath, { force: true }).catch(() => {})
  }
  const client = new DaemonClient({ socketPath: options.socketPath, tokenPath: options.tokenPath })
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let nextJobCheckMs = Date.now() + JOB_EXIT_CHECK_INTERVAL_MS
  try {
    while (true) {
      try {
        await client.ensureConnectedWithin(Math.max(1, deadline - Date.now()))
        break
      } catch (error) {
        client.disconnect()
        if (Date.now() >= deadline) {
          await abandonUnlessLive(error)
        }
        // A copy refused at exec (e.g. by Gatekeeper) never answers; hand off now, not at the deadline.
        if (Date.now() >= nextJobCheckMs) {
          nextJobCheckMs = Date.now() + JOB_EXIT_CHECK_INTERVAL_MS
          const state = await readMacDaemonJobState(service)
          if (state === 'stopped' || state === 'missing') {
            await abandonUnlessLive(error)
          }
        }
        await delay(50)
      }
    }
    const identity = client.getDaemonIdentity()
    if (!identity || identity.launchNonce !== options.launchNonce) {
      client.disconnect()
      // The fork launcher adopts an occupant normally rather than as a degraded endpoint.
      await stopMacDaemonJob(service)
      void retireUnusedMacDaemonBundle(bundle.directory)
      throw new MacDaemonStableLaunchUnavailableError('Another daemon owns the terminal endpoint', {
        cause: new DaemonEndpointOwnershipError('Another daemon owns the terminal endpoint')
      })
    }
    return await holdDaemonAdoptionLease(
      { shutdown },
      options.socketPath,
      options.tokenPath,
      client,
      identity,
      options.pidPath
    )
  } catch (error) {
    client.disconnect()
    throw error
  }
}
