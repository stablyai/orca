import { wslAwareSpawn } from '../git/runner'
import { bundledRipgrepCommand, bundledRipgrepWslSpawnOptions } from './bundled-ripgrep-path'
import { RIPGREP_MISSING_CWD_EXIT_CODE } from '../../shared/ripgrep-process-availability'

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

/** Centralize bundled rg spawning; bare names let Windows execute binaries from the workspace before PATH. */
export function spawnBundledRipgrep(
  args: string[],
  options: BundledRipgrepSpawnOptions
): ReturnType<typeof wslAwareSpawn> {
  const { wslDistro, wslDistroForOutput, ...spawnOptions } = options
  const command = bundledRipgrepCommand({ wsl: Boolean(wslDistroForOutput) })
  return wslAwareSpawn(command, args, {
    ...spawnOptions,
    ...(wslDistro ? { wslDistro } : {}),
    // Shell cd failure is exit 1 like rg no-match; WSL needs a distinct cwd verdict.
    ...(wslDistro || wslDistroForOutput
      ? { cwdFailureExitCode: RIPGREP_MISSING_CWD_EXIT_CODE }
      : {}),
    ...(wslDistroForOutput ? bundledRipgrepWslSpawnOptions(command) : {})
  })
}
