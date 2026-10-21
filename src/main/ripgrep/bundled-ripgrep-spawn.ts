import { wslAwareSpawn } from '../git/runner'
import { bundledRipgrepCommand, bundledRipgrepWslSpawnOptions } from './bundled-ripgrep-path'
import { RIPGREP_MISSING_CWD_EXIT_CODE } from '../../shared/ripgrep-process-availability'

// Why derived rather than imported from node:child_process: a direct import would land this file
// on the child_process ratchet's allowlist, which only ever shrinks.
type WslAwareSpawnOptions = Parameters<typeof wslAwareSpawn>[2]

export type BundledRipgrepSpawnOptions = Omit<
  WslAwareSpawnOptions,
  'wslDistro' | 'wslShellCommand' | 'useWslLoginShell'
> & {
  cwd: string
  /** Distro whose git options own this workspace; routes the spawn through wsl.exe. */
  wslDistro?: string
  /** Set when rg runs inside WSL, so it emits Linux paths the caller translates back. */
  wslDistroForOutput?: string
}

/**
 * The single way Orca spawns ripgrep: its own binary, routed into WSL when the workspace lives
 * there. Why one entry point: a bare `rg` must never reach spawn, because Windows resolves a bare
 * name in the spawn cwd — the repo — before PATH.
 */
export function spawnBundledRipgrep(
  args: string[],
  options: BundledRipgrepSpawnOptions
): ReturnType<typeof wslAwareSpawn> {
  const { wslDistro, wslDistroForOutput, ...spawnOptions } = options
  const command = bundledRipgrepCommand({ wsl: Boolean(wslDistroForOutput) })
  return wslAwareSpawn(command, args, {
    ...spawnOptions,
    ...(wslDistro ? { wslDistro } : {}),
    // Why only when routed into WSL: a native spawn reports an unusable cwd as a spawn error,
    // but inside `bash -c` a failed `cd` is just exit 1 -- the same code rg uses for "no matches".
    ...(wslDistro || wslDistroForOutput
      ? { cwdFailureExitCode: RIPGREP_MISSING_CWD_EXIT_CODE }
      : {}),
    ...(wslDistroForOutput ? bundledRipgrepWslSpawnOptions(command) : {})
  })
}
