#!/usr/bin/env node
// Validate saved layout against shared structural rules, including live dev profiles; print breaches and exit 1.
// Usage: node config/scripts/check-workspace-layout-rules.mjs <userDataDir>

import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const userDataDir = process.argv[2]
if (!userDataDir) {
  console.error('usage: check-workspace-layout-rules.mjs <userDataDir>')
  process.exit(2)
}

const root = resolve(import.meta.dirname, '..', '..')
await mkdir(join(root, '.tmp'), { recursive: true })
const scratch = await mkdtemp(join(root, '.tmp', 'layout-rules-'))
try {
  const outfile = join(scratch, 'check.cjs')
  await build({
    stdin: {
      contents: `
        export { readPersistedProfileState } from './tests/e2e/helpers/persisted-profile-state'
        export { partitionsFromProfileRoot } from './tests/e2e/helpers/workspace-layout-oracle-views'
        export { checkWorkspaceLayoutRules } from './src/shared/workspace-layout/workspace-layout-rules'
      `,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['electron', '@stablyai/playwright-test'],
    logLevel: 'silent'
  })
  const { readPersistedProfileState, partitionsFromProfileRoot, checkWorkspaceLayoutRules } =
    createRequire(import.meta.url)(outfile)
  const violations = checkWorkspaceLayoutRules(
    partitionsFromProfileRoot(readPersistedProfileState(resolve(userDataDir)))
  )
  for (const violation of violations) {
    console.log(`${violation.rule}: ${violation.detail}`)
  }
  console.log(`${violations.length} layout rule breach(es) in ${userDataDir}`)
  process.exitCode = violations.length > 0 ? 1 : 0
} finally {
  await rm(scratch, { recursive: true, force: true })
}
