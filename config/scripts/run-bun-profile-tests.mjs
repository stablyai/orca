import { join, resolve } from 'node:path'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { currentTarget } from './build-orcad-bun.mjs'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const target = currentTarget()
const runtimeDir = join(root, 'out', '.bun-profile-test-runtime', target)
const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }

function run(program, args) {
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    env,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    process.exit(result.code ?? 1)
  }
}

run(process.execPath, [
  join(root, 'config/scripts/build-orcad-bun.mjs'),
  '--runtime-only',
  '--out-dir',
  runtimeDir
])
run(join(runtimeDir, orcadBunRuntimeFilename(target)), [
  join(root, 'node_modules/vitest/vitest.mjs'),
  'run',
  '--config',
  'config/vitest.config.ts',
  ...(process.argv.length > 2
    ? process.argv.slice(2)
    : [
        'src/main/persistence/profile-state',
        'src/main/persistence/loading-store/profile-state',
        'src/main/sqlite'
      ])
])
