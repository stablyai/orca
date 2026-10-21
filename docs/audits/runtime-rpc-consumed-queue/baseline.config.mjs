import path from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, mergeConfig } from 'vitest/config'
import rootConfig from '../../../config/vitest.config.ts'

const require = createRequire(import.meta.url)
const proof = require('./queue-source.cjs')
const sourcePath = path.resolve(import.meta.dirname, '../../..', proof.versions.sourcePath)
export default mergeConfig(
  rootConfig,
  defineConfig({
    plugins: [
      {
        name: 'runtime-rpc-queue-baseline',
        enforce: 'pre',
        load(id) {
          if (id === sourcePath) {
            return proof.baselineSource
          }
        }
      }
    ],
    test: {
      include: [
        'src/shared/runtime-rpc-call-queue.test.ts',
        'src/shared/runtime-rpc-call-queue-retention.test.ts'
      ]
    }
  })
)
