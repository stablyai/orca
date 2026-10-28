import { assertWslDistroAllowed } from '@orca/process-host/wsl-distro-allowlist'
import {
  spawnShellWithFallback,
  type ShellSpawnParams,
  type ShellSpawnResult
} from './local-pty-utils'

type LocalPtySpawn = (
  params: Omit<ShellSpawnParams, 'ptySpawn'> & { signal?: AbortSignal }
) => ShellSpawnResult | Promise<ShellSpawnResult>

/** Degraded daemon routing loads node-pty lazily, as the daemon does. */
export async function loadLocalPtyRuntimeSpawn(): Promise<LocalPtySpawn> {
  const pty = await import('node-pty')
  const ptySpawn: typeof pty.spawn = (file, args, options) => {
    assertWslDistroAllowed(file, args)
    return pty.spawn(file, args, options)
  }
  return (params) => spawnShellWithFallback({ ...params, ptySpawn })
}
