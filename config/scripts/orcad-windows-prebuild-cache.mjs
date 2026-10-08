import { createHash } from 'node:crypto'
import { appendFileSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'
import { assertNodePtyPatchApplied } from './build-orcad-prebuilds.mjs'
import {
  findPostBaselineNodeApiNames,
  findSlotProblems,
  MANIFEST_SCHEMA_VERSION,
  readManifest,
  sha256Of,
  slotSourceFiles,
  SLOT_NAPI_VERSION
} from './orcad-prebuild-slot-contents.mjs'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../..')
const ownership = require('./node-pty-job-ownership.cjs')
export const WINDOWS_PREBUILD_CACHE_INPUTS = [
  'package.json',
  '.github/actions/prepare-orcad-prebuilds/action.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'config/patches/node-pty@1.1.0.patch',
  'src/shared/node-runtime-pin.ts',
  'config/scripts/build-orcad-prebuilds.mjs',
  'config/scripts/orcad-prebuild-slot-contents.mjs',
  'config/scripts/orcad-windows-prebuild-cache.mjs',
  'config/scripts/node-pty-job-ownership.cjs',
  'config/scripts/windows-pe-machine.cjs',
  'config/scripts/pinned-node-downloads.mjs',
  'config/scripts/update-node-runtime-pin.mjs',
  'config/scripts/script-child-process.mjs',
  'src/shared/child-process/run-process.ts',
  'src/shared/child-process/spawn-resolution.ts',
  'src/shared/child-process/process-tree-termination.ts',
  'src/shared/child-process/process-tree-kill-gate.ts',
  'src/shared/child-process/spawn-observer.ts',
  'src/shared/child-process/bounded-output-sink.ts',
  'src/shared/child-process/child-termination-reporter.ts',
  'src/shared/child-process/process-spec.ts',
  'src/shared/child-process/windows-command-line.ts',
  'src/shared/child-process/windows-cmd-shim-resolution.ts'
]

function windowsSlot(platform, arch) {
  if (platform !== 'win32' || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Windows prebuild caching requires win32 x64/arm64, got ${platform}/${arch}`)
  }
  return `win32-${arch}`
}

export function windowsPrebuildCacheIdentity({
  repository = root,
  platform = process.platform,
  arch = process.arch,
  imageOS = process.env.ImageOS,
  imageVersion = process.env.ImageVersion
} = {}) {
  const slot = windowsSlot(platform, arch)
  if (!imageOS || !imageVersion) {
    throw new Error('Windows prebuild cache needs the hosted ImageOS and ImageVersion')
  }
  const digest = createHash('sha256').update(JSON.stringify({ slot, imageOS, imageVersion }))
  for (const file of WINDOWS_PREBUILD_CACHE_INPUTS) {
    digest.update(`\0${file}\0`).update(readFileSync(join(repository, file)))
  }
  return {
    slot,
    key: `orcad-windows-prebuild-v1-${slot}-${digest.digest('hex')}`,
    path: join(repository, 'out', 'orcad-prebuilds')
  }
}

function filesBelow(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new Error(`Cached payload cannot contain symlinks: ${relative}`)
    }
    return entry.isDirectory()
      ? [`${relative}/`, ...filesBelow(join(directory, entry.name), `${relative}/`)]
      : [relative]
  })
}

export function validateWindowsPrebuildCache({
  prebuildsDir = join(root, 'out', 'orcad-prebuilds'),
  sourceDir = dirname(require.resolve('node-pty/package.json')),
  platform = process.platform,
  arch = process.arch
} = {}) {
  const slot = windowsSlot(platform, arch)
  assertNodePtyPatchApplied(sourceDir)
  readFileSync(join(sourceDir, 'src', 'win', 'conpty.cc'))
  ownership.assertNodePtySourceDeniesMsysBreakaway({ nodePtyDir: sourceDir })
  for (const directory of [prebuildsDir, join(prebuildsDir, slot)]) {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
      throw new Error(`Cached payload must use a real directory: ${directory}`)
    }
  }
  if (!lstatSync(join(prebuildsDir, 'manifest.json')).isFile()) {
    throw new Error('Cached manifest must be a regular file')
  }
  const manifest = readManifest(prebuildsDir)
  const sourceVersion = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')).version
  if (
    manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    manifest.module !== 'node-pty' ||
    manifest.version !== sourceVersion ||
    manifest.napi !== SLOT_NAPI_VERSION ||
    manifest.nodeHeaders !== NODE_RUNTIME_PIN.version
  ) {
    throw new Error(
      'Cached Windows prebuild manifest does not match the current module/N-API/headers'
    )
  }
  const entry = manifest.slots?.[slot]
  if (
    entry?.platform !== platform ||
    entry.arch !== arch ||
    entry.libc !== 'none' ||
    entry.glibc !== null ||
    entry.napi !== SLOT_NAPI_VERSION
  ) {
    throw new Error(`Cached ${slot} metadata does not match this Windows host`)
  }
  const slotDir = join(prebuildsDir, slot)
  const sources = slotSourceFiles({ platform, arch, buildDir: slotDir, nodePtyDir: sourceDir })
  const expected = sources.map(([relative]) => relative).sort()
  const sameFiles = (files, expectedFiles) =>
    JSON.stringify(files.sort()) === JSON.stringify(expectedFiles.sort())
  if (
    !sameFiles(Object.keys(entry.files ?? {}), expected) ||
    !sameFiles(filesBelow(slotDir), [...expected, 'conpty/'])
  ) {
    throw new Error(`Cached ${slot} must contain exactly the current ConPTY payload`)
  }
  const problems = findSlotProblems(manifest, prebuildsDir, [slot])
  if (problems.length > 0) {
    throw new Error(`Cached ${slot} is invalid: ${problems.join('; ')}`)
  }
  for (const [relative, source] of sources.filter(([file]) => file !== 'conpty.node')) {
    if (sha256Of(source) !== entry.files[relative]) {
      throw new Error(`Cached ${slot}/${relative} differs from the current vendored ConPTY payload`)
    }
  }
  for (const relative of expected.filter((file) => file.endsWith('.node'))) {
    const newer = findPostBaselineNodeApiNames(readFileSync(join(slotDir, relative)))
    if (newer.length > 0) {
      throw new Error(
        `Cached ${slot}/${relative} imports ${newer.join(', ')}, above N-API ${SLOT_NAPI_VERSION}`
      )
    }
  }
  const addon = join(slotDir, 'conpty.node')
  ownership.assertRebuiltConptyMatchesArch(addon, arch)
  ownership.assertCygwinBreakawayDenied(addon, { dir: slotDir })
  return slot
}

if (process.argv[1]?.endsWith('orcad-windows-prebuild-cache.mjs')) {
  if (process.argv.includes('--fingerprint')) {
    const identity = windowsPrebuildCacheIdentity()
    if (process.env.GITHUB_OUTPUT) {
      for (const [name, value] of Object.entries(identity)) {
        appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
      }
    }
    console.log(JSON.stringify(identity))
  } else if (process.argv.includes('--validate')) {
    console.log(`[orcad-prebuilds] validated cached ${validateWindowsPrebuildCache()}`)
  } else {
    throw new Error('Usage: orcad-windows-prebuild-cache.mjs --fingerprint | --validate')
  }
}
