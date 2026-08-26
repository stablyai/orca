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
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME } from '../../src/shared/relay-artifacts.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PACKAGE_DIR = join(ROOT, 'node_modules', '@vscode', 'windows-process-tree')
const SUPPORTED_ARCHES = ['x64', 'arm64']

/** PE `IMAGE_FILE_HEADER.Machine` values, so a cross-build cannot silently emit host arch. */
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }

function parseArgs(argv) {
  const arch = argv.find((a) => a.startsWith('--arch='))?.slice('--arch='.length) ?? process.arch
  const outDir = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new Error(`--arch must be one of ${SUPPORTED_ARCHES.join(', ')}; got ${arch}`)
  }
  return {
    arch,
    outDir: outDir ? resolve(outDir) : join(ROOT, '.build', 'windows-process-tree', arch)
  }
}

/**
 * Refuse to build unpatched source.
 *
 * Each hunk fails differently: Spectre dies outright, the 1024-process cap
 * succeeds and lies, and `.targets` is cwd-relative so pnpm's nested layout
 * makes node-gyp miss node_addon_api.gyp on Windows. Checking the source
 * rather than trusting the install is what stops a silently unpatched tree
 * from being shipped as if it were patched.
 */
function assertPatchApplied() {
  const bindingGyp = readFileSync(join(PACKAGE_DIR, 'binding.gyp'), 'utf8')
  if (bindingGyp.includes('SpectreMitigation')) {
    throw new Error(
      'binding.gyp still requests SpectreMitigation. pnpm did not apply ' +
        'config/patches/@vscode__windows-process-tree@0.8.0.patch; run pnpm install.'
    )
  }
  if (!bindingGyp.includes("require.resolve('node-addon-api/node_addon_api.gyp')")) {
    throw new Error(
      'binding.gyp still uses require("node-addon-api").targets. That path is ' +
        'cwd-relative and misses node_addon_api.gyp under pnpm on Windows. ' +
        'pnpm did not apply config/patches/@vscode__windows-process-tree@0.8.0.patch; run pnpm install.'
    )
  }
  const processCc = readFileSync(join(PACKAGE_DIR, 'src', 'process.cc'), 'utf8')
  if (processCc.includes('process_count < 1024')) {
    throw new Error(
      'src/process.cc still caps enumeration at 1024 processes. pnpm did not apply ' +
        'config/patches/@vscode__windows-process-tree@0.8.0.patch; run pnpm install.'
    )
  }
}

/** Read the PE machine field, so an arm64 request cannot ship an x64 binary. */
function readPeMachine(binaryPath) {
  const fd = openSync(binaryPath, 'r')
  try {
    const header = Buffer.alloc(4)
    readSync(fd, header, 0, 4, 0x3c)
    const peOffset = header.readUInt32LE(0)
    const machine = Buffer.alloc(2)
    readSync(fd, machine, 0, 2, peOffset + 4)
    return machine.readUInt16LE(0)
  } finally {
    closeSync(fd)
  }
}

function main() {
  const { arch, outDir } = parseArgs(process.argv.slice(2))
  if (process.platform !== 'win32') {
    throw new Error(
      `This addon only builds on Windows; running on ${process.platform}. ` +
        'Relay builds elsewhere simply omit it and fall back to the CIM scan.'
    )
  }
  if (!existsSync(PACKAGE_DIR)) {
    throw new Error(`${PACKAGE_DIR} is missing. Run pnpm install first.`)
  }
  assertPatchApplied()

  console.log(`[windows-process-tree] building ${arch} from ${PACKAGE_DIR}`)
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'), 'rebuild', `--arch=${arch}`],
    { cwd: PACKAGE_DIR, stdio: 'inherit' }
  )

  const built = join(PACKAGE_DIR, 'build', 'Release', 'windows_process_tree.node')
  if (!existsSync(built)) {
    throw new Error(`node-gyp reported success but ${built} is missing.`)
  }
  const machine = readPeMachine(built)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(
      `Built binary is machine 0x${machine.toString(16)}, expected 0x${PE_MACHINE[arch].toString(16)} for ${arch}. ` +
        'node-gyp ignored --arch; a relay would get a binary its host cannot load.'
    )
  }

  mkdirSync(outDir, { recursive: true })
  const staged = join(outDir, RELAY_WINDOWS_PROCESS_TREE_FILENAME)
  copyFileSync(built, staged)
  console.log(`[windows-process-tree] ${arch} -> ${staged}`)
}

try {
  main()
} catch (error) {
  console.error(`[windows-process-tree] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
