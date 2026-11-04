import type { TerminalCreationWork } from '../../daemon/terminal-creation-work'
import { trackLocalPtyCreation } from './local-pty-creation-proof'
import { assertWslDistroAllowed } from '@orca/process-host/wsl-distro-allowlist'
import {
  spawnShellWithFallback,
  type ShellSpawnParams,
  type ShellSpawnResult
} from './local-pty-executable-spawn'
import { reportNodePtyLoadFailure } from '../node-pty-load-failure'

type LocalPtySpawn = (
  params: Omit<ShellSpawnParams, 'ptySpawn'> & {
    signal?: AbortSignal
    creationWork?: TerminalCreationWork
    assertCreateAllowed?: () => void
  }
) => ShellSpawnResult | Promise<ShellSpawnResult>

/** Degraded daemon routing loads node-pty lazily, as the daemon does. */
export async function loadLocalPtyRuntimeSpawn(): Promise<LocalPtySpawn> {
  const pty = await import('node-pty').catch((error: unknown) => {
    reportNodePtyLoadFailure(error)
    throw error
  })
  const ptySpawn: typeof pty.spawn = (file, args, options) => {
    assertWslDistroAllowed(file, args)
    return pty.spawn(file, args, options)
  }
  return ({ creationWork, assertCreateAllowed, ...params }) =>
    spawnShellWithFallback({
      ...params,
      ptySpawn: (file, args, options) => {
        assertCreateAllowed?.()
        return creationWork
          ? trackLocalPtyCreation(creationWork, () => ptySpawn(file, args, options))
          : ptySpawn(file, args, options)
      }
    })
}
