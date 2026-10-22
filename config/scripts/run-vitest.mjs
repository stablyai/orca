import { resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import {
  checkBunVersion,
  probeBunVersion,
  readPinnedBunVersion,
  resolvePinnedBunExecutable
} from './pinned-bun-executable.mjs'

const root = resolve(import.meta.dirname, '../..')
const pinnedBun = resolvePinnedBunExecutable(root, runProcessSync)
const bunCheck = pinnedBun
  ? { ok: true }
  : checkBunVersion(probeBunVersion('bun', root, runProcessSync), readPinnedBunVersion(root))
if (bunCheck.message) {
  console.error(bunCheck.message)
}
if (!bunCheck.ok) {
  process.exitCode = 1
} else {
  try {
    const result = runProcessSync({
      program: pinnedBun ?? 'bun',
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
}
