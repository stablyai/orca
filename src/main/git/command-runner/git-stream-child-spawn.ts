import { spawn, type ChildProcess } from 'node:child_process'
import { spawnNativeProcess } from '@orca/process-host/native-process-spawn'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import type { ResolvedCommand } from './host-routing/wsl-command-resolution'
import { untranslatedGitOutputEnv } from './git-environment/git-process-env'
import { gitSpawn, type GitSpawnOptions } from './git-spawn'
import {
  canSpawnOnWorkerThread,
  childSpawnerIsIsolated,
  spawnProcessOnWorkerThread,
  type WorkerThreadChildProcess
} from '../../worker-thread-child-process/worker-thread-child-process'

/** Starts a streamed Git child; ownedGroupChild is set only when it leads its own POSIX group. */
export function spawnGitStreamChild(
  command: ResolvedCommand,
  args: string[],
  spawnOptions: GitSpawnOptions
): {
  child: ChildProcess | WorkerThreadChildProcess
  ownedGroupChild: ChildProcess | null
  workerOwnsGroup?: true
} {
  if (
    process.platform === 'linux' &&
    !command.wsl &&
    childSpawnerIsIsolated() &&
    canSpawnOnWorkerThread()
  ) {
    // From the utility-process spawner, so the child holds none of main's Chromium sockets.
    const spawnStartedAt = performance.now()
    const child = spawnProcessOnWorkerThread({
      program: command.binary,
      args: command.args,
      cwd: command.cwd,
      env: untranslatedGitOutputEnv(spawnOptions.env ?? process.env),
      terminationBarrier: true
    })
    child.stdin.end()
    recordSubprocessSpawn(command.binary, command.args, performance.now() - spawnStartedAt)
    // It leads its own group, which the worker stops; a stop sent before the pid arrives waits for it.
    return { child, ownedGroupChild: null, workerOwnsGroup: true }
  }
  if (process.platform !== 'win32' && !command.wsl) {
    const child = spawnNativeProcess(
      command.binary,
      command.args,
      {
        cwd: command.cwd,
        env: untranslatedGitOutputEnv(spawnOptions.env),
        stdio: spawnOptions.stdio,
        windowsHide: true,
        detached: true
      },
      undefined,
      recordSubprocessSpawn
    )
    return { child, ownedGroupChild: child }
  }
  const spawnStartedAt = performance.now()
  if (process.platform === 'win32' && canSpawnOnWorkerThread()) {
    // Windows CreateProcessW can stall the calling loop for seconds under endpoint security (#11161, #27362).
    // The resolved command is the one main would start: native Git, WSL's direct Git, or wsl.exe.
    const child = spawnProcessOnWorkerThread({
      program: command.binary,
      args: command.args,
      cwd: command.cwd,
      env: untranslatedGitOutputEnv(spawnOptions.env ?? process.env)
    })
    child.stdin.end()
    recordSubprocessSpawn(command.binary, command.args, performance.now() - spawnStartedAt)
    return { child, ownedGroupChild: null }
  }
  if (command.wslMode === 'direct-git') {
    const child = spawn(command.binary, command.args, {
      cwd: command.cwd,
      env: untranslatedGitOutputEnv(spawnOptions.env),
      stdio: spawnOptions.stdio,
      windowsHide: true
    })
    recordSubprocessSpawn(command.binary, command.args, performance.now() - spawnStartedAt)
    return { child, ownedGroupChild: null }
  }
  return { child: gitSpawn(args, spawnOptions), ownedGroupChild: null }
}
