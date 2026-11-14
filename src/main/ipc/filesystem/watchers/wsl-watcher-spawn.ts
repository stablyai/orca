import { spawnProcess } from '@orca/process-host'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveWslInteropSpawnCwd } from '../../../wsl/execution/wsl-interop-spawn-directory'

/** Start the in-distro poll script; process-host applies the internal distro allowlist. */
export function spawnWslWatcherProcess(
  distro: string,
  linuxPath: string
): ChildProcessWithoutNullStreams {
  return spawnProcess({
    program: 'wsl.exe',
    args: ['-d', distro, '--exec', 'sh', '-s', '--', linuxPath],
    stdio: 'pipe',
    // Inherited cwd may be a deleted worktree, causing spawn wsl.exe ENOENT (#16463).
    cwd: resolveWslInteropSpawnCwd()
  })
}
