#!/usr/bin/env node

import assert from 'node:assert/strict'
import { AGENT_HOOK_TARGETS } from '../../src/shared/agent-hook-types.ts'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
]
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)

assert.equal(process.versions.bun, ORCAD_BUN_VERSION, 'Run this smoke with the pinned Bun runtime')

const home = process.env.ORCA_MANAGED_HOOK_SMOKE_HOME
assert.ok(home, 'Use run-managed-hook-runtime-smoke.mjs to supply an isolated home')
assert.equal(homedir(), home, 'Refuse to install hooks outside the isolated smoke home')
const originalGetuid = process.getuid
process.getuid = undefined

try {
  const runtimes = PLATFORMS.map((platform) => {
    const artifact = join(ROOT, 'out', 'relay', platform, 'managed-hook-runtime.js')
    const runtime = require(artifact)
    assert.equal(typeof runtime.installManagedHooks, 'function', `${platform} installer export`)
    return runtime
  })

  const summary = await runtimes[0].installManagedHooks({ agents: AGENT_HOOK_TARGETS })
  assert.deepEqual(summary, { installers: AGENT_HOOK_TARGETS.length, errors: 0 })

  const codexHooks = await readFile(join(home, '.codex', 'hooks.json'), 'utf8')
  const claudeSettings = await readFile(join(home, '.claude', 'settings.json'), 'utf8')
  assert.match(codexHooks, /\.orca\/agent-hooks\/codex-hook\.sh/)
  assert.match(claudeSettings, /\.orca\/agent-hooks\/claude-hook\.sh/)
  await access(join(home, '.orca', 'agent-hooks', 'codex-hook.sh'), constants.X_OK)
  await access(join(home, '.orca', 'agent-hooks', 'claude-hook.sh'), constants.X_OK)
} finally {
  process.getuid = originalGetuid
}

console.log('All relay hook bundles loaded; every managed installer passed on the current host.')
