import { join, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { currentTarget } from './build-orcad-bun.mjs'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const runtimeDir = join(root, 'out', '.managed-hook-bun', currentTarget())
function run(program, args, environment = {}) {
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ...environment },
    stdio: 'inherit',
    timeoutMs: 180_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Smoke subprocess failed: ${result.code}`)
  }
}
run(process.execPath, [
  join(root, 'config/scripts/build-orcad-bun.mjs'),
  '--runtime-only',
  '--out-dir',
  runtimeDir
])
const home = await mkdtemp(join(tmpdir(), 'orca-managed-hook-bun-'))
try {
  run(
    join(runtimeDir, orcadBunRuntimeFilename(currentTarget())),
    [join(root, 'config/scripts/smoke-managed-hook-runtime-bun.mjs')],
    {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      GROK_HOME: join(home, '.grok'),
      SHELL: '/bin/sh',
      ORCA_MANAGED_HOOK_SMOKE_HOME: home
    }
  )
} finally {
  await rm(home, { recursive: true, force: true })
}
