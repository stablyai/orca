// Conda's activation state is a coupled group, not independent keys: CONDA_SHLVL
// is a sentinel asserting CONDA_PREFIX exists. Every other PTY env scrubber here
// treats keys one at a time, so a half-activated host env (a client envToDelete,
// the wsl.exe/WSLENV boundary, a relay launched from a half-activated login
// shell, a launchd/PAM env reshuffle) is forwarded verbatim and `conda activate`
// dies in `_get_deactivate_scripts(None)` with a TypeError (#14195).

/** Activation state: meaningful only while CONDA_PREFIX names an active env. */
const ACTIVATION_STATE_KEYS = [
  'CONDA_SHLVL',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'CONDA_PROMPT_MODIFIER'
] as const

/** Stack depth is unbounded (`CONDA_PREFIX_1`, `CONDA_STACKED_2`, ...). */
const POSIX_STACK_KEY = /^(?:CONDA_PREFIX|CONDA_STACKED)_\d+$/
const WINDOWS_STACK_KEY = /^(?:CONDA_PREFIX|CONDA_STACKED)_\d+$/i

/**
 * Drops conda's activation-state group when the sentinel survived but the prefix
 * did not, so the shell's conda hook starts from a clean slate instead of
 * crashing. Installation/discovery vars (CONDA_EXE, CONDA_ROOT, CONDA_BAT,
 * CONDA_PYTHON_EXE, _CE_CONDA, _CE_M) are preserved so `conda` still resolves.
 *
 * Why delete-only, never synthesize: the reverse shape (prefix without sentinel)
 * does not crash — conda just reads it as inactive — and Orca cannot verify the
 * prefix directory exists on the executing host (it routinely does not for WSL
 * and SSH), so inventing activation state would be worse than leaving it.
 */
export function dropIncoherentCondaActivationEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform
): void {
  const windows = platform === 'win32'
  // Why: PTY spawn is a hot path; one exact-key miss covers every non-conda posix env.
  if (!windows && env.CONDA_SHLVL === undefined) {
    return
  }
  const keys = Object.keys(env)
  // Why case-insensitive on win32 only: Windows env names are case-insensitive, so a
  // conda install or PowerShell profile may spell them `Conda_Shlvl` (same reasoning as
  // stripLegacyTerminalShimEnv). On POSIX a lowercase name is a different variable.
  const findKey = (name: string): string | undefined => {
    if (!windows) {
      return env[name] === undefined ? undefined : name
    }
    const lowered = name.toLowerCase()
    return keys.find((key) => key.toLowerCase() === lowered)
  }

  const shlvlKey = findKey('CONDA_SHLVL')
  // CONDA_SHLVL=0 (or unparsable) is conda's own hook-ran-nothing-active state.
  if (shlvlKey === undefined || !(Number.parseInt(env[shlvlKey] ?? '', 10) > 0)) {
    return
  }
  const prefixKey = findKey('CONDA_PREFIX')
  if (prefixKey !== undefined && env[prefixKey] !== '') {
    return
  }

  const stateKeys = new Set<string>(
    windows ? ACTIVATION_STATE_KEYS.map((key) => key.toLowerCase()) : ACTIVATION_STATE_KEYS
  )
  const stackKey = windows ? WINDOWS_STACK_KEY : POSIX_STACK_KEY
  for (const key of keys) {
    if (stateKeys.has(windows ? key.toLowerCase() : key) || stackKey.test(key)) {
      delete env[key]
    }
  }
}
