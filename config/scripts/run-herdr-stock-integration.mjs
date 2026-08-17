#!/usr/bin/env node
// Why: download the pinned stock herdr binary for this host and run the
// stock-runtime integration test against it, in one cross-platform step.
// Keeps the binary acquisition and the ORCA_HERDR_TEST_BINARY wiring out of
// every caller (local `pnpm test:herdr:stock`, CI lanes).
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const scriptDir = import.meta.dirname
const repoRoot = join(scriptDir, '..', '..')

function runNode(args, env) {
  execFileSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit', env })
}

const herdrBinary = execFileSync(
  process.execPath,
  [join(scriptDir, 'download-herdr-release.mjs')],
  { cwd: repoRoot, encoding: 'utf8' }
).trim()

const vitestEntry = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
runNode(
  [
    vitestEntry,
    'run',
    '--config',
    'config/vitest.config.ts',
    'src/main/providers/multiplexer/herdr/herdr-real-runtime.integration.test.ts'
  ],
  { ...process.env, ORCA_HERDR_TEST_BINARY: herdrBinary }
)
