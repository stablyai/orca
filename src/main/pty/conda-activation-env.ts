// A surviving CONDA_SHLVL without CONDA_PREFIX crashes conda activate (#14195).

const ACTIVATION_STATE_KEYS = [
  'CONDA_SHLVL',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'CONDA_PROMPT_MODIFIER'
] as const

/** Stack depth is unbounded (`CONDA_PREFIX_1`, `CONDA_STACKED_2`, ...). */
const POSIX_STACK_KEY = /^(?:CONDA_PREFIX|CONDA_STACKED)_\d+$/
const WINDOWS_STACK_KEY = /^(?:CONDA_PREFIX|CONDA_STACKED)_\d+$/i

/** Drop incoherent activation state while preserving installation/discovery keys.
 * Never synthesize a prefix: its path may belong to a WSL/SSH host we cannot inspect; prefix-only state is inactive. */
export function dropIncoherentCondaActivationEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform
): void {
  const windows = platform === 'win32'
  // Avoid scanning ordinary POSIX env on the spawn hot path.
  if (!windows && env.CONDA_SHLVL === undefined) {
    return
  }
  const keys = Object.keys(env)
  // Windows env names are case-insensitive; POSIX names remain distinct.
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
