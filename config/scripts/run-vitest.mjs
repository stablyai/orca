import { resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'

const root = resolve(import.meta.dirname, '../..')
try {
  const result = runProcessSync({
    program: 'bun',
    args: ['--bun', resolve(root, 'node_modules/vitest/vitest.mjs'), ...process.argv.slice(2)],
    cwd: root,
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_TEST_NODE_EXECUTABLE: process.execPath,
      ORCA_TEST_NODE_VERSION: process.versions.node
    },
    stdio: 'inherit',
    timeoutMs: null
  })

  process.exitCode = result.code ?? 1
} catch (error) {
  console.error('Could not start Vitest. Install the Bun version in config/.bun-version.', error)
  process.exitCode = 1
}
