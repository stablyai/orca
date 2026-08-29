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
  readSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME } from '../../src/shared/relay-artifacts.ts'
import {
  nodeGypRebuildInvocation,
  WINDOWS_PROCESS_TREE_PACKAGE_DIR as PACKAGE_DIR
} from './windows-process-tree-gyp-rebuild.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
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
  if (bindingGyp.includes('node_addon_api.gyp')) {
    throw new Error(
      'binding.gyp still depends on node_addon_api.gyp. pnpm and node-gyp rewrite that ' +
        'project path incorrectly on Windows. ' +
        'pnpm did not apply config/patches/@vscode__windows-process-tree@0.8.0.patch; run pnpm install.'
    )
  }
  if (!bindingGyp.includes('"include_dirs": ["deps/node-addon-api"]')) {
    throw new Error('binding.gyp does not use the staged node-addon-api headers.')
  }
  const processCc = readFileSync(join(PACKAGE_DIR, 'src', 'process.cc'), 'utf8')
  if (processCc.includes('process_count < 1024')) {
    throw new Error(
      'src/process.cc still caps enumeration at 1024 processes. pnpm did not apply ' +
        'config/patches/@vscode__windows-process-tree@0.8.0.patch; run pnpm install.'
    )
  }
}

// pnpm can materialize this CRLF package without applying its patch. Repair the
// load-bearing build settings before node-gyp so the release build stays safe.
function applyWindowsProcessTreeBuildFixes() {
  const bindingPath = join(PACKAGE_DIR, 'binding.gyp')
  const processPath = join(PACKAGE_DIR, 'src', 'process.cc')
  const nodeAddonApiDir = dirname(
    createRequire(join(PACKAGE_DIR, 'package.json')).resolve('node-addon-api/package.json')
  )
  const stagedHeaderDir = join(PACKAGE_DIR, 'deps', 'node-addon-api')
  let bindingGyp = readFileSync(bindingPath, 'utf8')
  let processCc = readFileSync(processPath, 'utf8')
  const originalBinding = bindingGyp
  const originalProcess = processCc

  for (const dynamicDependency of [
    String.raw`<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except`,
    String.raw`<!(node -p \"require.resolve('node-addon-api/node_addon_api.gyp')\"):node_addon_api_except`,
    '../../node-addon-api/node_addon_api.gyp:node_addon_api_except'
  ]) {
    bindingGyp = bindingGyp.replace(`"${dynamicDependency}",`, '')
  }
  bindingGyp = bindingGyp.replace(
    '"include_dirs": []',
    '"include_dirs": ["deps/node-addon-api"],\n          "defines": ["NAPI_CPP_EXCEPTIONS", "_HAS_EXCEPTIONS=1"]'
  )
  if (!bindingGyp.includes('"ExceptionHandling": 1')) {
    bindingGyp = bindingGyp.replace(
      '"VCCLCompilerTool": {',
      '"VCCLCompilerTool": {\n              "ExceptionHandling": 1,'
    )
  }
  bindingGyp = bindingGyp.replace(
    /\r?\n\s*"msvs_configuration_attributes": \{\s*"SpectreMitigation": "Spectre"\s*\},?/s,
    ''
  )
  processCc = processCc.replace(/process_count < 1024 && /, '')

  if (bindingGyp !== originalBinding) {
    writeFileSync(bindingPath, bindingGyp)
  }
  if (processCc !== originalProcess) {
    writeFileSync(processPath, processCc)
  }
  mkdirSync(stagedHeaderDir, { recursive: true })
  for (const header of ['napi.h', 'napi-inl.h', 'napi-inl.deprecated.h']) {
    copyFileSync(join(nodeAddonApiDir, header), join(stagedHeaderDir, header))
  }
  if (bindingGyp !== originalBinding || processCc !== originalProcess) {
    console.warn('[windows-process-tree] Repaired un-applied pnpm patch hunks before build.')
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
  applyWindowsProcessTreeBuildFixes()
  assertPatchApplied()

  const gyp = nodeGypRebuildInvocation(arch)
  console.log(`[windows-process-tree] building ${arch} from ${gyp.cwd}`)
  execFileSync(process.execPath, gyp.args, { cwd: gyp.cwd, stdio: 'inherit' })

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
