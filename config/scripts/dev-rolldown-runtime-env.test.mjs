import { describe, expect, it } from 'vitest'
import {
  removeDevRolldownRuntimeEnv,
  withDevRolldownRuntimeEnv
} from './dev-rolldown-runtime-env.mjs'

describe('dev Rolldown runtime env', () => {
  it('removes only the keys it added, keeping caller choices', () => {
    const env = withDevRolldownRuntimeEnv({ RAYON_NUM_THREADS: '2', PATH: '/bin' }, 24)
    expect(env).toMatchObject({
      MIMALLOC_PURGE_DELAY: '0',
      ROLLDOWN_WORKER_THREADS: '4',
      RAYON_NUM_THREADS: '2'
    })
    removeDevRolldownRuntimeEnv(env)
    expect(env).toEqual({ RAYON_NUM_THREADS: '2', PATH: '/bin' })
  })

  it('keeps Rolldown thread defaults on small hosts', () => {
    expect(withDevRolldownRuntimeEnv({}, 4)).toEqual({
      MIMALLOC_PURGE_DELAY: '0',
      ORCA_DEV_RUNTIME_ENV_KEYS: 'MIMALLOC_PURGE_DELAY'
    })
  })
})
