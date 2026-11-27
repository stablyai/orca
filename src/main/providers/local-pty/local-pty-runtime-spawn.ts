import { dropInheritedNiceBoost } from '@orca/process-host/native-process-spawn'
import { assertWslDistroAllowed } from '@orca/process-host/wsl-distro-allowlist'
import {
  spawnShellWithFallback,
  type ShellSpawnParams,
  type ShellSpawnResult
} from './local-pty-executable-spawn'
import { reportNodePtyLoadFailure } from '../pty/node-pty-load-failure'

type LocalPtySpawn = (
  params: Omit<ShellSpawnParams, 'ptySpawn'> & { signal?: AbortSignal }
) => ShellSpawnResult | Promise<ShellSpawnResult>

/** Degraded daemon routing loads node-pty lazily, as the daemon does. */
export async function loadLocalPtyRuntimeSpawn(): Promise<LocalPtySpawn> {
  const pty = await import('node-pty').catch((error: unknown) => {
    reportNodePtyLoadFailure(error)
    throw error
  })
  const ptySpawn: typeof pty.spawn = (file, args, options) => {
    assertWslDistroAllowed(file, args)
    const spawned = pty.spawn(file, args, options)
    // Linux-only; see native-pty-spawn.ts (#51055).
    if (process.platform === 'linux') {
      dropInheritedNiceBoost(spawned.pid)
    }
    return spawned
  }
  return (params) => spawnShellWithFallback({ ...params, ptySpawn })
}
