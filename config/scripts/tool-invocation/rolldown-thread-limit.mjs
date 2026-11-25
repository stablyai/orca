import os from 'node:os'

// Measured on 24 threads: Rolldown's default 24+24 workers cost ~25% more CPU than 8 for no wall-time gain.
const maxRolldownThreads = '8'

/** Caps Rolldown's Tokio and Rayon pools on large hosts unless the caller already chose sizes. */
export function withRolldownThreadLimit(env, availableParallelism = os.availableParallelism()) {
  if (availableParallelism <= Number(maxRolldownThreads)) {
    return env
  }
  return {
    ...env,
    ROLLDOWN_WORKER_THREADS: env.ROLLDOWN_WORKER_THREADS ?? maxRolldownThreads,
    RAYON_NUM_THREADS: env.RAYON_NUM_THREADS ?? maxRolldownThreads
  }
}
