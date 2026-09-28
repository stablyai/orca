import { win32 } from 'node:path'
import { forkProcess, type ForkSpec } from '../../shared/child-process/fork-process'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import { getAppEnvironment } from '../../shared/app-environment'
import { buildDurableDaemonScopeCommand } from './daemon-cgroup-scope'
import { daemonLogArgs } from './daemon-launch-paths'

export type DaemonChildSpawnOptions = {
  entryPath: string
  forkEntryPath: string
  relocatedExecPath?: string
  bunRuntime?: boolean
  conptyLibraryPath?: string
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

/** Preserve detached lifetime and readiness IPC, including the optional sibling systemd scope. */
export function spawnDaemonChildProcess(
  options: DaemonChildSpawnOptions,
  useDurableScope: boolean
): SpawnedProcess {
  const { forkEntryPath, relocatedExecPath, userDataPath, launchNonce } = options
  const scriptArgs = buildDaemonScriptArgs(options)
  const usesBun = Boolean(
    options.bunRuntime ||
    (process.versions.bun && (!relocatedExecPath || relocatedExecPath === process.execPath))
  )
  // Desktop launches select Bun explicitly; orcad forks its current Bun runtime.
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // Detached daemons need shell rcfiles outside swept temporary directories.
    ORCA_USER_DATA_PATH: userDataPath
  }
  if (usesBun) {
    delete daemonEnv.ELECTRON_RUN_AS_NODE
    delete daemonEnv.NODE_OPTIONS
    delete daemonEnv.NODE_PATH
    delete daemonEnv.BUN_OPTIONS
  }
  if (options.bunRuntime) {
    delete daemonEnv.BUN_CONPTY_LIBRARY
    if (process.platform === 'win32') {
      if (!options.conptyLibraryPath || !win32.isAbsolute(options.conptyLibraryPath)) {
        throw new Error('Windows Bun daemon ConPTY library path must be absolute')
      }
      daemonEnv.BUN_CONPTY_LIBRARY = options.conptyLibraryPath
    }
  }
  // Why cwd: detached daemons outlive dev worktrees; userData keeps process.cwd() valid after a repo/worktree is deleted.
  // Why detached/stdio: detached+unref outlives Electron; stdout 'ignore' (else blocks exit), stderr 'pipe' captures startup crashes lost in v1.4.129-rc.1.
  const childOptions: Pick<ForkSpec, 'cwd' | 'detached' | 'stdio'> = {
    cwd: userDataPath,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  }
  if (options.bunRuntime && !relocatedExecPath) {
    throw new Error('Bun daemon runtime path is missing')
  }
  if (!useDurableScope && options.bunRuntime && relocatedExecPath) {
    return spawnProcess({
      ...childOptions,
      program: relocatedExecPath,
      args: [...bunOwnedRuntimeArgs(), forkEntryPath, ...scriptArgs],
      env: daemonEnv
    })
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
    [
      ...(usesBun ? bunOwnedRuntimeArgs() : []),
      forkEntryPath,
      ...scriptArgs,
      '--fresh-daemon-scope'
    ],
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
