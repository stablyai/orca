import { spawn, type ChildProcess } from 'node:child_process'
import { resolveCliCommand } from '../codex-cli/command'
import { wslAwareSpawn } from '../git/runner'
import { getSpawnArgsForWindows } from '../../shared/windows-batch-spawn'

export type CodexAppServerProcess = Pick<
  ChildProcess,
  'stdin' | 'stdout' | 'stderr' | 'on' | 'off' | 'once' | 'kill' | 'pid'
>

export type CodexAppServerProcessFactory = () => CodexAppServerProcess

export type SpawnCodexAppServerOptions = {
  command?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  wslDistro?: string
}

export function createCodexAppServerProcessFactory(
  options: SpawnCodexAppServerOptions = {}
): CodexAppServerProcessFactory {
  return () => spawnCodexAppServer(options)
}

export function spawnCodexAppServer(options: SpawnCodexAppServerOptions = {}): ChildProcess {
  const command = options.command?.trim() || 'codex'
  const args = ['app-server']
  const env = options.env ?? process.env

  if (process.platform === 'win32' && options.wslDistro) {
    return wslAwareSpawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      wslDistro: options.wslDistro,
      useWslLoginShell: true
    })
  }

  const resolved = resolveCliCommand(command, {
    pathEnv: env.PATH ?? env.Path ?? null
  })
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolved, args)
  return spawn(spawnCmd, spawnArgs, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}
