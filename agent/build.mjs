#!/usr/bin/env node
/**
 * build.mjs — Build the Orca Dev Agent as a standalone package.
 * Adapted from the monorepo's config/scripts/build-agent-only.mjs — same
 * esbuild options, paths rebased to this package's own root (no ../.. hop
 * into a shared repo root; agent/ is fully self-contained).
 *
 * Output:  out/agent.js  (standalone Node.js CJS bundle)
 * Runtime: Node.js 22+ on any Linux/macOS/Windows dev server
 */

import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const __dirname = import.meta.dirname
const ROOT = __dirname
const AGENT_ENTRY = join(ROOT, 'src', 'relay', 'agent-entry.ts')
const AGENT_OUT = join(ROOT, 'out', 'agent.js')
const VERSION_OUT = join(ROOT, 'out', '.agent-version')
const AGENT_VERSION = '2.1.0'

const t0 = Date.now()

if (!existsSync(AGENT_ENTRY)) {
  console.error(`ERROR: Entry point not found: ${AGENT_ENTRY}`)
  process.exit(1)
}

const watchMode = process.argv.includes('--watch')

console.log('Building Orca Dev Agent (standalone package)...')
console.log(`  Entry:  ${AGENT_ENTRY}`)
console.log(`  Output: ${AGENT_OUT}`)

mkdirSync(join(ROOT, 'out'), { recursive: true })

const buildOptions = {
  entryPoints: [AGENT_ENTRY],
  outfile: AGENT_OUT,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // cpu-features: ssh2's optional native crypto accelerator (ssh-outbound-client.ts,
  // BACKLOG-001) — ssh2 itself already wraps the require in try/catch and
  // falls back to pure-JS crypto when it's absent (lib/protocol/constants.js),
  // same reasoning as every other native-binding package below; esbuild
  // otherwise fails trying to bundle its .node binary directly.
  external: ['node-pty', 'better-sqlite3', 'keytar', '@parcel/watcher', 'electron', 'cpu-features'],
  sourcemap: false,
  minify: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info'
}

if (watchMode) {
  const ctx = await build({ ...buildOptions, logLevel: 'debug' })
  await ctx.watch?.()
  console.log('Watching for changes (Ctrl+C to stop)...')
} else {
  await build(buildOptions)

  const content = readFileSync(AGENT_OUT)
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12)
  const version = `${AGENT_VERSION}+${hash}`
  writeFileSync(VERSION_OUT, version)

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const sizeKB = (content.length / 1024).toFixed(0)
  console.log(`✅ Agent built in ${elapsed}s — ${sizeKB} KB — ${version} — out/agent.js`)
}
