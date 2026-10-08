import base from '../../../config/vitest.config.ts'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { loadSources, root, versions } = require('./sources.cjs')
const baseline = loadSources().baseline
const target = join(root, versions.sourcePath).replaceAll('\\', '/')

export default {
  ...base,
  test: {
    ...base.test,
    include: [
      'src/main/native-chat/agent-session-wire/agent-session-delta-coalescer.test.ts',
      'src/main/native-chat/agent-session-wire/agent-session-empty-delta-retention.test.ts'
    ]
  },
  plugins: [
    {
      name: 'exact-baseline-coalescer',
      enforce: 'pre',
      transform(_code, id) {
        return id.replaceAll('\\', '/').split('?')[0] === target
          ? { code: baseline, map: null }
          : null
      }
    }
  ]
}
