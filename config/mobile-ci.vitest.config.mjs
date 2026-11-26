import { availableParallelism } from 'node:os'
import { defaultExclude, mergeConfig } from 'vitest/config'
import original from '../mobile/vitest.config.ts'

// Keep real process, native, and runtime-specific contracts on Node.
const nodeFiles = ['src/transport/encryption/mobile-e2ee-v2-client-session.test.ts']

const config = mergeConfig(original, { cacheDir: process.env.ORCA_MOBILE_CI_CACHE_DIR })

// Assign include after merging: mergeConfig concatenates arrays.
export default {
  ...config,
  test: {
    ...config.test,
    isolate: true,
    ...(process.versions.bun
      ? {
          // The Node role holds one core; more Bun workers than the rest starve timed tests on 2-core runners.
          maxWorkers: Math.max(1, Math.min(3, availableParallelism() - 1)),
          exclude: [...(config.test?.exclude ?? defaultExclude), ...nodeFiles]
        }
      : { maxWorkers: 1, include: nodeFiles })
  }
}
