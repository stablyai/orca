import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  ORCAD_VERSION_FILENAME,
  orcadBunRuntimeFilename
} from '../../src/shared/orcad-artifacts.ts'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  parseOrcadProfilePreflight
} from '../../src/shared/orcad-profile-preflight.ts'
import { currentTarget } from './build-orcad-bun.mjs'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const target = currentTarget()
const artifact = process.argv.includes('--artifact')
const testArgs = process.argv.slice(2).filter((arg) => arg !== '--artifact')
const runtimeDir = artifact
  ? join(root, 'out', 'orcad')
  : join(root, 'out', '.bun-profile-test-runtime', target)
const runtimePath = join(runtimeDir, orcadBunRuntimeFilename(target))
const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', BUN_EXECUTABLE: runtimePath }

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

if (artifact) {
  const nonce = randomUUID()
  const result = runProcessSync({
    program: runtimePath,
    args: [join(runtimeDir, 'orcad.js'), ORCAD_PROFILE_PREFLIGHT_FLAG, nonce],
    cwd: root,
    env,
    timeoutMs: 90_000
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(`Bundled runtime readiness failed: ${result.stderr}`)
  }
  const response = parseOrcadProfilePreflight(
    result.stdout,
    nonce,
    ORCAD_BUN_VERSION,
    readFileSync(join(runtimeDir, ORCAD_VERSION_FILENAME), 'utf8').trim()
  )
  process.stdout.write(`${JSON.stringify({ target, ...response })}\n`)
} else {
  run(process.execPath, [
    join(root, 'config/scripts/build-orcad-bun.mjs'),
    '--runtime-only',
    '--out-dir',
    runtimeDir
  ])
}
run(runtimePath, [
  join(root, 'node_modules/vitest/vitest.mjs'),
  'run',
  '--config',
  'config/vitest.config.ts',
  ...(testArgs.length > 0
    ? testArgs
    : [
        'src/main/persistence/profile-state',
        'src/main/persistence/loading-store/profile-state',
        'src/main/sqlite',
        ...(artifact
          ? [
              'src/main/daemon/pty-subprocess/bun-pty-process.integration.test.ts',
              'src/main/daemon/pty-subprocess/windows-bun-pty-gate.integration.test.ts'
            ]
          : [])
      ])
])
