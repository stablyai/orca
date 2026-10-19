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

/**
 * The two ways the daemon's OS process comes into being: the long-standing direct `fork()`, and
 * (`useDurableScope`) the identical command line wrapped in `systemd-run --user --scope` so the
 * daemon lands in a sibling cgroup instead of the caller's — see daemon-cgroup-scope.ts. The
 * wrapper needs `spawn()` because it is not a Node script, but it takes the same `'ipc'` stdio
 * contract and the process it execs into inherits the channel, so the readiness handshake is
 * unchanged. Do not read the daemon's PID off the returned child; the daemon reports its own
 * (see daemon-ready-identity.ts).
 *
 * Both arms go through the process-host chokepoint (`@orca/process-host`), which
 * is what every caller outside that directory must use — `forkProcess` for the Node-module arm,
 * `spawnProcess` for the program arm.
 */
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
  // Why: run as plain Node so Electron's GPU/display init can't interfere with node-pty's posix_spawn of the spawn-helper.
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // Why: the detached plain-Node daemon has no AppEnvironment, but shell rcfiles must live outside swept tmp.
    ORCA_USER_DATA_PATH: userDataPath
  }
  // Why: this env becomes the daemon's, and so every PTY's (#21119).
  removeChromiumDisabledSessionBus(daemonEnv)
  // Why cwd: detached daemons outlive dev worktrees; userData keeps process.cwd() valid after a repo/worktree is deleted.
  // Why detached/stdio: detached+unref outlives Electron; stdout 'ignore' (else blocks exit), stderr 'pipe' captures startup crashes lost in v1.4.129-rc.1.
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
      // Why: run the byte-identical relocated Orca.exe so the image path sits outside the updater's kill zone.
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
