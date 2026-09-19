import { createRequire } from 'node:module'
import base from '../../../config/vitest.config'

const sources = createRequire(import.meta.url)('./sources.cjs')
export default {
  ...base,
  plugins: [sources.phasePlugin('current-before')],
  test: {
    ...base.test,
    include: ['src/main/ipc/runtime-environment-session-retirement.test.ts'],
    maxWorkers: 1
  }
}
