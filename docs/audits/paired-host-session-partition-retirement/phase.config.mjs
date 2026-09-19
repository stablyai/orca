import base from '../../../config/vitest.config'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sources = require('./sources.cjs')

const phase = `${process.env.ORCA_PARTITION_SNAPSHOT}-${process.env.ORCA_PARTITION_VARIANT}`
export default {
  ...base,
  plugins: [sources.phasePlugin(phase)],
  test: {
    ...base.test,
    include: ['docs/audits/paired-host-session-partition-retirement/scenario.test.mjs'],
    maxWorkers: 1,
    execArgv: base.test.execArgv.filter(
      (arg) =>
        arg !== '--no-experimental-webstorage' || Number(process.versions.node.split('.')[0]) >= 26
    )
  }
}
