import os from 'node:os'

export const DEV_RUNTIME_ENV_KEYS = 'ORCA_DEV_RUNTIME_ENV_KEYS'

// Measured idle electron-vite RSS 4.6GB -> 3.0GB with no HMR or startup regression.
const DEV_THREADS = '4'
const DEV_RUNTIME_DEFAULTS = {
  // mimalloc otherwise keeps freed Rolldown arenas resident for the whole dev session.
  MIMALLOC_PURGE_DELAY: '0',
  ROLLDOWN_WORKER_THREADS: DEV_THREADS,
  RAYON_NUM_THREADS: DEV_THREADS
}

/** Sizes the dev server's Rolldown runtime; records added keys so Electron's environment can drop them. */
export function withDevRolldownRuntimeEnv(env, availableParallelism = os.availableParallelism()) {
  const added = Object.entries(DEV_RUNTIME_DEFAULTS).filter(
    ([key]) =>
      env[key] === undefined &&
      (key === 'MIMALLOC_PURGE_DELAY' || availableParallelism > Number(DEV_THREADS))
  )
  if (added.length === 0) {
    return env
  }
  return {
    ...env,
    ...Object.fromEntries(added),
    [DEV_RUNTIME_ENV_KEYS]: added.map(([key]) => key).join(',')
  }
}

/** Rolldown has read these before the renderer server starts; dev Electron's terminals must not inherit them. */
export function removeDevRolldownRuntimeEnv(env) {
  for (const key of (env[DEV_RUNTIME_ENV_KEYS] ?? '').split(',')) {
    if (key) {
      delete env[key]
    }
  }
  delete env[DEV_RUNTIME_ENV_KEYS]
}
