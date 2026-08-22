#!/usr/bin/env node

import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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

assert.match(process.versions.node, /^18\./, 'This smoke test must run under Node 18')

const home = await mkdtemp(join(tmpdir(), 'orca-managed-hook-node18-'))
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalGetuid = process.getuid
process.env.HOME = home
process.env.USERPROFILE = home
process.getuid = undefined

try {
  const runtimes = PLATFORMS.map((platform) => {
    const artifact = join(ROOT, 'out', 'relay', platform, 'managed-hook-runtime.js')
    const runtime = require(artifact)
    assert.equal(typeof runtime.installManagedHooks, 'function', `${platform} installer export`)
    return runtime
  })

  const summary = await runtimes[0].installManagedHooks({ agents: ['codex', 'claude'] })
  assert.equal(summary.installers, 2)
  assert.equal(summary.errors, 0)
  // Why: #8711 made the runtime return per-agent statuses so a host reports
  // which agent failed instead of a bare count. Sorted because install order
  // is not the caller's agent order.
  assert.deepEqual(
    [...summary.statuses]
      .sort((a, b) => a.agent.localeCompare(b.agent))
      .map(({ agent, state, managedHooksPresent }) => ({ agent, state, managedHooksPresent })),
    [
      { agent: 'claude', state: 'installed', managedHooksPresent: true },
      { agent: 'codex', state: 'installed', managedHooksPresent: true }
    ]
  )
  for (const status of summary.statuses) {
    // Each status must name a path on the host that was actually installed to.
    assert.equal(status.configPath.startsWith(home), true, `${status.agent} configPath under home`)
  }

  const codexHooks = await readFile(join(home, '.codex', 'hooks.json'), 'utf8')
  const claudeSettings = await readFile(join(home, '.claude', 'settings.json'), 'utf8')
  assert.match(codexHooks, /\.orca\/agent-hooks\/codex-hook\.sh/)
  assert.match(claudeSettings, /\.orca\/agent-hooks\/claude-hook\.sh/)
  await access(join(home, '.orca', 'agent-hooks', 'codex-hook.sh'), constants.X_OK)
  await access(join(home, '.orca', 'agent-hooks', 'claude-hook.sh'), constants.X_OK)
} finally {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  process.getuid = originalGetuid
  await rm(home, { recursive: true, force: true })
}

console.log('Node 18 managed-hook runtime smoke passed for all relay platforms.')
