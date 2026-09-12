#!/usr/bin/env node
/**
 * Materialize the pinned Bun matrix, then build strict relay packages.
 * Release artifacts must not silently regress to host-Node-only relays.
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ORCAD_BUN_TARGETS, ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const runtimeRoot = resolve(
  process.env.ORCA_RELAY_BUN_RUNTIME_ROOT ??
    join(root, 'out', '.relay-bun-runtime', `v${ORCAD_BUN_VERSION}`)
)
const materializer = join(root, 'config', 'scripts', 'build-orcad-bun.mjs')
const relayBuilder = join(root, 'config', 'scripts', 'build-relay.mjs')

mkdirSync(runtimeRoot, { recursive: true })
for (const target of ORCAD_BUN_TARGETS) {
  const targetRoot = join(runtimeRoot, target)
  const result = runProcessSync({
    program: process.execPath,
    args: [materializer, '--target', target, '--runtime-only', '--out-dir', targetRoot],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(
      `Bun runtime materialization failed for ${target} (exit ${result.code ?? 'unknown'})`
    )
  }
}

const result = runProcessSync({
  program: process.execPath,
  args: [relayBuilder],
  cwd: root,
  env: {
    ...process.env,
    ORCA_RELAY_BUN_RUNTIME_ROOT: runtimeRoot,
    ORCA_REQUIRE_RELAY_BUN_RUNTIME: '1'
  },
  stdio: 'inherit',
  timeoutMs: null
})
if (result.code !== 0) {
  process.exit(result.code ?? 1)
}
process.stdout.write(`[build-relay-release] strict Bun relay build complete (${runtimeRoot})\n`)
