import { forkProcess, type ForkSpec } from '../../shared/child-process/fork-process'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { getAppEnvironment } from '../../shared/app-environment'
import { buildDurableDaemonScopeCommand } from './daemon-cgroup-scope'
import { daemonLogArgs } from './daemon-launch-paths'

export type DaemonChildSpawnOptions = {
  entryPath: string
  forkEntryPath: string
  relocatedExecPath?: string
  userDataPath: string
  socketPath: string
  tokenPath: string
  pidPath: string
  launchNonce: string
  macosLoginSessionWatch: boolean
}

function buildDaemonScriptArgs(options: DaemonChildSpawnOptions): string[] {
  const { socketPath, tokenPath, pidPath, launchNonce, entryPath, macosLoginSessionWatch } = options
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
    entryPath,
    '--app-version',
    getAppEnvironment().getVersion(),
    '--spawner-exec-path',
    process.execPath,
    ...(macosLoginSessionWatch ? ['--login-session-watch'] : []),
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
 * Both arms go through the shared child-process chokepoint (`src/shared/child-process`), which
 * is what every caller outside that directory must use — `forkProcess` for the Node-module arm,
 * `spawnProcess` for the program arm.
 */
export function spawnDaemonChildProcess(
  options: DaemonChildSpawnOptions,
  useDurableScope: boolean
): SpawnedProcess {
  const { forkEntryPath, relocatedExecPath, userDataPath, launchNonce } = options
  const scriptArgs = buildDaemonScriptArgs(options)
  // Why: run as plain Node so Electron's GPU/display init can't interfere with node-pty's posix_spawn of the spawn-helper.
  const daemonEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // Why: the detached plain-Node daemon has no AppEnvironment, but shell rcfiles must live outside swept tmp.
    ORCA_USER_DATA_PATH: userDataPath
  }
  // Why cwd: detached daemons outlive dev worktrees; userData keeps process.cwd() valid after a repo/worktree is deleted.
  // Why detached/stdio: detached+unref outlives Electron; stdout 'ignore' (else blocks exit), stderr 'pipe' captures startup crashes lost in v1.4.129-rc.1.
  const childOptions: Pick<ForkSpec, 'cwd' | 'detached' | 'stdio'> = {
    cwd: userDataPath,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  }
  if (!useDurableScope) {
    return forkProcess({
      ...childOptions,
      modulePath: forkEntryPath,
      args: scriptArgs,
      // Why: run the byte-identical relocated Orca.exe so the image path sits outside the updater's kill zone.
      ...(relocatedExecPath ? { execPath: relocatedExecPath } : {}),
      env: daemonEnv
    })
  }
  const scoped = buildDurableDaemonScopeCommand(
    relocatedExecPath ?? process.execPath,
    [forkEntryPath, ...scriptArgs],
    launchNonce,
    daemonEnv
  )
  return spawnProcess({
    ...childOptions,
    program: scoped.command,
    args: scoped.args,
    env: scoped.env
  })
}
