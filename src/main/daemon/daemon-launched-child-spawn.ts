import { forkProcess, type ForkSpec } from '@orca/process-host/fork-process'
import { spawnProcess } from '@orca/process-host'
import type { SpawnedProcess } from '@orca/process-host/process-spec'
import { getAppEnvironment } from '../../shared/app-environment'
import { removeChromiumDisabledSessionBus } from '../pty/chromium-session-bus-env'
import {
  appImageDaemonIdentityPath,
  buildAppImageDaemonCommand,
  type AppImageDaemonLaunch
} from './daemon-appimage-launch'
import { buildDurableDaemonScopeCommand } from './daemon-cgroup-scope'
import {
  buildAppImageGenerationDaemonCommand,
  type AppImageGenerationDaemonLaunch
} from './daemon-appimage-generation-launch'
import { daemonLogArgs } from './daemon-launch-paths'
import { TERMINAL_SPAWN_ADMISSION_ARG } from './terminal-spawn-gate'

export type DaemonChildSpawnOptions = {
  entryPath: string
  forkEntryPath: string
  relocatedExecPath?: string
  /** Linux AppImage: exec the AppImage file so the daemon owns its mount. */
  appImage?: AppImageDaemonLaunch
  /** Linux AppImage: run the bundled Node inside the extracted copy, off every mount. */
  extractedGeneration?: AppImageGenerationDaemonLaunch
  userDataPath: string
  socketPath: string
  tokenPath: string
  pidPath: string
  launchNonce: string
  macosLoginSessionWatch: boolean
  spawnAdmission?: 'observe' | 'enforce'
  /** Defaults to 10 s; a cold first exec on Windows can need longer. */
  startupTimeoutMs?: number
}

export function buildDaemonScriptArgs(
  options: Omit<DaemonChildSpawnOptions, 'forkEntryPath' | 'relocatedExecPath'>,
  spawnerExecPath = process.execPath
): string[] {
  const {
    socketPath,
    tokenPath,
    pidPath,
    launchNonce,
    entryPath,
    appImage,
    extractedGeneration,
    macosLoginSessionWatch
  } = options
  return [
    '--socket',
    socketPath,
    '--token',
    tokenPath,
    '--pid-record',
    pidPath,
    '--launch-nonce',
    launchNonce,
    '--entry-path',
    extractedGeneration?.identityPath ??
      (appImage ? appImageDaemonIdentityPath(appImage) : entryPath),
    '--app-version',
    getAppEnvironment().getVersion(),
    '--spawner-exec-path',
    spawnerExecPath,
    ...(macosLoginSessionWatch ? ['--login-session-watch'] : []),
    ...(options.spawnAdmission === 'enforce' ? [TERMINAL_SPAWN_ADMISSION_ARG, 'enforce'] : []),
    ...daemonLogArgs()
  ]
}

/** Wrappers inherit readiness IPC; use the daemon's self-reported identity, not the wrapper PID. */
export function spawnDaemonChildProcess(
  options: DaemonChildSpawnOptions,
  useDurableScope: boolean
): SpawnedProcess {
  const {
    forkEntryPath,
    relocatedExecPath,
    appImage,
    extractedGeneration,
    userDataPath,
    launchNonce
  } = options
  const scriptArgs = buildDaemonScriptArgs(options)
  // Plain Node avoids Electron display initialization interfering with node-pty spawn-helper.
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // The detached daemon lacks AppEnvironment; rcfiles must stay outside swept temporary directories.
    ORCA_USER_DATA_PATH: userDataPath
  }
  // Every PTY inherits this environment (#21119).
  removeChromiumDisabledSessionBus(daemonEnv)
  // Use durable cwd: detached daemons outlive their dev worktrees.
  // Detach from Electron; ignore stdout to allow exit and pipe stderr for startup failures.
  const childOptions: Pick<ForkSpec, 'cwd' | 'detached' | 'stdio'> = {
    cwd: userDataPath,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  }
  if (!useDurableScope && !appImage && !extractedGeneration) {
    return forkProcess({
      ...childOptions,
      modulePath: forkEntryPath,
      args: scriptArgs,
      // Keep the byte-identical Orca.exe outside the updater's kill zone.
      ...(relocatedExecPath ? { execPath: relocatedExecPath } : {}),
      env: daemonEnv
    })
  }
  const scopeArgs = useDurableScope ? ['--fresh-daemon-scope'] : []
  const direct = extractedGeneration
    ? buildAppImageGenerationDaemonCommand(
        extractedGeneration,
        [...scriptArgs, ...scopeArgs],
        daemonEnv
      )
    : appImage
      ? buildAppImageDaemonCommand(appImage, [...scriptArgs, ...scopeArgs], daemonEnv)
      : {
          command: relocatedExecPath ?? process.execPath,
          args: [forkEntryPath, ...scriptArgs, ...scopeArgs],
          env: daemonEnv
        }
  const scoped = useDurableScope
    ? buildDurableDaemonScopeCommand(direct.command, direct.args, launchNonce, direct.env)
    : direct
  return spawnProcess({
    ...childOptions,
    program: scoped.command,
    args: scoped.args,
    env: scoped.env
  })
}
