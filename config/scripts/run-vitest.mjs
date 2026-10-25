import { resolve } from 'node:path'
import { runProcess, runProcessSync } from '@orca/process-host'
import { hasNoChangedFiles } from './vitest-changed-precheck.mjs'
import { RUN_ARGS_ENV } from './vitest-run-filters.mjs'
import { createVitestZodBundle } from './vitest-zod-bundle.mjs'
import {
  checkBunVersion,
  probeBunVersion,
  readPinnedBunVersion,
  resolvePinnedBunExecutable
} from './pinned-bun-executable.mjs'

const root = resolve(import.meta.dirname, '../..')
const vitestArgs = process.argv.slice(2)

function runVitest() {
  const pinnedBun = resolvePinnedBunExecutable(root, runProcessSync)
  const bunCheck = pinnedBun
    ? { ok: true }
    : checkBunVersion(probeBunVersion('bun', root, runProcessSync), readPinnedBunVersion(root))
  if (bunCheck.message) {
    console.error(bunCheck.message)
  }
  if (!bunCheck.ok) {
    return 1
  }
  try {
    const zodBundle = createVitestZodBundle(root)
    const result = runProcessSync({
      program: pinnedBun ?? 'bun',
      args: ['--bun', resolve(root, 'node_modules/vitest/vitest.mjs'), ...vitestArgs],
      cwd: root,
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_TEST_NODE_EXECUTABLE: process.execPath,
        ORCA_TEST_NODE_VERSION: process.versions.node,
        ORCA_UNIT_ZOD_BUNDLE: zodBundle.path,
        [RUN_ARGS_ENV]: JSON.stringify(vitestArgs),
        // The config's TypeScript and CommonJS package scope are intended; the notice is noise.
        VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true'
      },
      stdio: 'inherit',
      timeoutMs: null
    })
    return result.code ?? 1
  } catch (error) {
    console.error('Could not prepare or start Vitest:', error)
    return 1
  }
}

if (await hasNoChangedFiles(vitestArgs, root, runProcess)) {
  // Vitest's own result for this case, without paying its startup.
  console.log('No changed files found, exiting with code 0')
} else {
  process.exitCode = runVitest()
}
