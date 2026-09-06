#!/usr/bin/env node
/**
 * Compile `@vscode/windows-process-tree` for a relay host.
 *
 * The relay is deployed to machines with no compiler, and this addon cannot be
 * npm-installed there: it carries a binding.gyp, so npm rebuilds from source and
 * the build wants Spectre-mitigated libraries even where MSVC is present. The
 * binary inside the published tarball loads, but predates our patch and still
 * caps enumeration at 1024 processes -- a busy host then gets a truncated table
 * missing its own pid, which reads as "unavailable" only under load.
 *
 * So we compile it here, from the patched source pnpm already materialized, and
 * ship the result as a relay artifact. Windows arm64 cross-compiles from an x64
 * runner, so both arches come off one Windows job.
 *
 * Node headers, not Electron: the relay runs under the host's own `node`. The
 * addon is N-API, so one build serves every Node the remote might have.
 *
 *   node config/scripts/build-windows-process-tree-relay-addon.mjs --arch=arm64
 */
import { join, resolve } from 'node:path'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME } from '../../src/shared/relay-artifacts.ts'
import { rebuildWindowsProcessTreeForNode } from './windows-process-tree-gyp-rebuild.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')

async function main() {
  const arch = process.argv.find((arg) => arg.startsWith('--arch='))?.slice(7) ?? process.arch
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`--arch must be x64 or arm64; got ${arch}`)
  }
  if (process.platform !== 'win32') {
    throw new Error('This addon only builds on Windows.')
  }
  const output = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6)
  const outDir = output ? resolve(output) : join(ROOT, '.build', 'windows-process-tree', arch)
  const staged = await rebuildWindowsProcessTreeForNode({
    arch,
    outFile: join(outDir, RELAY_WINDOWS_PROCESS_TREE_FILENAME)
  })
  console.log(`[windows-process-tree] ${arch} -> ${staged}`)
}

try {
  await main()
} catch (error) {
  console.error(`[windows-process-tree] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
