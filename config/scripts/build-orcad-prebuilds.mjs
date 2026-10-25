#!/usr/bin/env node
// Build patched node-pty for current platform/arch/libc so deployment needs no compiler; compat slots also build COMPAT_SLOT_ADDONS.
// Require repo patch: GLIBC symbol pins plus no-as-needed retain libutil/libpthread and prevent #9902.
// Use pinned, hash-verified Node headers at N-API 8; glibc slots target 2.28, optional compat 2.17, musl stays separate.
// CI merges per-slot outputs; --slot overrides detection. Options: --require-slots [a,b], --smoke, --print-slot, --print-runtime.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'
import {
  assertCompatSlotHost,
  findPostBaselineNodeApiNames,
  findSharedCxxRuntimeNeeds,
  findSlotProblems,
  highestGlibcNeed,
  isCompatSlot,
  mergeManifest,
  readManifest,
  sha256Of,
  slotGlibcFloor,
  slotSourceFiles,
  SLOT_NAPI_VERSION
} from './orcad-prebuild-slot-contents.mjs'
import { compileCompatAddons } from './orcad-prebuild-compat-addons.mjs'
import { nodeGypRebuild, stageNodeAddonApi } from './orcad-prebuild-node-gyp.mjs'
import { ensurePinnedNodeExecutable, preparePinnedNodeDir } from './pinned-node-downloads.mjs'

export { readManifest }

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, '..', '..')
// Why outside out/orcad: build:orcad wipes that directory and copies its target's slot from here.
export const ORCAD_PREBUILDS_DIR = join(ROOT, 'out', 'orcad-prebuilds')
const PREBUILDS_DIR = ORCAD_PREBUILDS_DIR
const WORK_DIR = join(ROOT, 'out', 'orcad-prebuild-work')

/** Every slot a shipped matrix must fill. The single source of truth for the matrix. */
export const MATRIX_SLOTS = [
  'linux-x64-glibc',
  'linux-arm64-glibc',
  'linux-x64-musl',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
]

// glibcVersionRuntime identifies glibc linkage; musl has no dependable ldd output.
export function detectLibc(platform = process.platform, header = readReportHeader()) {
  if (platform !== 'linux') {
    return 'none'
  }
  return header && typeof header === 'object' && 'glibcVersionRuntime' in header ? 'glibc' : 'musl'
}

function readReportHeader() {
  try {
    return process.report?.getReport?.()?.header
  } catch {
    return undefined
  }
}

export function slotName(argv = process.argv, platform = process.platform, arch = process.arch) {
  const forced = argv.find((arg) => arg.startsWith('--slot='))
  if (forced) {
    return forced.slice('--slot='.length)
  }
  const libc = detectLibc(platform)
  return libc === 'none' ? `${platform}-${arch}` : `${platform}-${arch}-${libc}`
}

/** `--require-slots` alone means the whole matrix; `--require-slots a,b` or `=a,b` names slots. */
export function requestedSlots(argv = process.argv) {
  const index = argv.findIndex(
    (arg) => arg === '--require-slots' || arg.startsWith('--require-slots=')
  )
  if (index === -1) {
    return null
  }
  const inline = argv[index].slice('--require-slots='.length)
  const next = argv[index + 1]
  const list = argv[index].includes('=') ? inline : next && !next.startsWith('--') ? next : ''
  const slots = list.split(',').filter(Boolean)
  return slots.length > 0 ? slots : MATRIX_SLOTS
}

// Reject missing patch or build-host success can hide target GLIBC load failures in shipped prebuilts.
export function assertNodePtyPatchApplied(nodePtyDir) {
  const bindingGyp = readFileSync(join(nodePtyDir, 'binding.gyp'), 'utf8')
  const ptySource = readFileSync(join(nodePtyDir, 'src', 'unix', 'pty.cc'), 'utf8')
  const missing = []
  if (!bindingGyp.includes('--no-as-needed,-l:libutil.so.1')) {
    missing.push("binding.gyp is missing the '--no-as-needed,-l:libutil.so.1' ldflag")
  }
  if (!ptySource.includes('.symver openpty,openpty@')) {
    missing.push('src/unix/pty.cc is missing the .symver glibc pins')
  }
  if (missing.length > 0) {
    throw new Error(
      [
        '[orcad-prebuilds] refusing to build: config/patches/node-pty@1.1.0.patch is not applied.',
        ...missing.map((line) => `  - ${line}`),
        'A prebuilt compiled without it will not load on Ubuntu 20.04 (#9902).',
        'Run `pnpm install` to apply patches.'
      ].join('\n')
    )
  }
}

const GLIBC_DT_NEEDED_LDFLAG = "'-Wl,--no-as-needed,-l:libutil.so.1,-l:libpthread.so.0,--as-needed'"

// musl has openpty/forkpty in libc and only a static libutil stub; omit glibc DT_NEEDED flags.
export function bindingGypForLibc(bindingGyp, libc) {
  if (libc !== 'musl') {
    return bindingGyp
  }
  if (!bindingGyp.includes(GLIBC_DT_NEEDED_LDFLAG)) {
    throw new Error(
      '[orcad-prebuilds] binding.gyp no longer carries the glibc ldflag this build strips on musl'
    )
  }
  return bindingGyp.replace(GLIBC_DT_NEEDED_LDFLAG, '')
}

const GLIBC_SYMVER_GUARD =
  '#if defined(__linux__)\n#  if defined(__x86_64__)\n#    define ORCA_GLIBC_COMPAT_VERSION'

// Guard GLIBC symbol pins: musl has no versioned GLIBC symbols and never defines __GLIBC__.
export function ptySourceForLibc(ptySource, libc) {
  if (libc !== 'musl') {
    return ptySource
  }
  if (!ptySource.includes(GLIBC_SYMVER_GUARD)) {
    throw new Error(
      '[orcad-prebuilds] pty.cc no longer carries the glibc .symver guard this build scopes on musl'
    )
  }
  return ptySource.replace(
    GLIBC_SYMVER_GUARD,
    GLIBC_SYMVER_GUARD.replace('defined(__linux__)', 'defined(__linux__) && defined(__GLIBC__)')
  )
}

function nodePtyDir() {
  return dirname(require.resolve('node-pty/package.json'))
}

// Build in scratch or Node-header compilation overwrites desktop’s Electron addon.
async function compileNodePty(sourceDir, slot) {
  const workDir = join(WORK_DIR, slot)
  const stagedDir = join(workDir, 'node-pty')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(stagedDir, { recursive: true })
  for (const entry of ['package.json', 'src']) {
    cpSync(join(sourceDir, entry), join(stagedDir, entry), { recursive: true })
  }
  const libc = detectLibc()
  writeFileSync(
    join(stagedDir, 'binding.gyp'),
    bindingGypForLibc(readFileSync(join(sourceDir, 'binding.gyp'), 'utf8'), libc)
  )
  const ptySourcePath = join(stagedDir, 'src', 'unix', 'pty.cc')
  writeFileSync(ptySourcePath, ptySourceForLibc(readFileSync(ptySourcePath, 'utf8'), libc))
  stageNodeAddonApi(sourceDir, stagedDir)
  if (process.platform === 'win32') {
    require('./node-pty-job-ownership.cjs').assertNodePtySourceDeniesMsysBreakaway({
      nodePtyDir: stagedDir
    })
  }
  const nodeDir = await preparePinnedNodeDir({ target: slot, workDir: join(workDir, 'nodedir') })

  console.log(
    `[orcad-prebuilds] compiling patched node-pty for ${slot} against Node ${NODE_RUNTIME_PIN.version} headers, N-API ${SLOT_NAPI_VERSION} ...`
  )
  const buildDir = await nodeGypRebuild({
    stagedDir,
    workDir,
    nodeDir,
    staticCxxRuntime: isCompatSlot(slot)
  })
  if (process.platform === 'win32') {
    require('./node-pty-job-ownership.cjs').assertRebuiltConptyDeniesMsysBreakaway({
      nodePtyDir: stagedDir,
      rebuildArch: process.arch,
      crossHost: false
    })
  }
  return { buildDir, nodeDir }
}

function requireSlots(slots) {
  const problems = findSlotProblems(readManifest(PREBUILDS_DIR), PREBUILDS_DIR, slots)
  if (problems.length > 0) {
    console.error(
      `[orcad-prebuilds] matrix incomplete:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Hosts on those slots fall back to a source build and need a C/C++ toolchain.'
    )
    process.exitCode = 1
    return
  }
  console.log(`[orcad-prebuilds] verified ${slots.length} slot(s): ${slots.join(', ')}`)
}

// Always gate Linux architecture; apply glibc/libstdc++ floors only to glibc slots.
function linuxSlotRecord(slot, slotDir, libc) {
  const floor = require('./verify-linux-glibc-floor.cjs')
  if (libc !== 'glibc') {
    for (const binary of floor.collectNativeBinaries(slotDir)) {
      const violation = floor.findArchViolation(binary, process.arch, slotDir)
      if (violation) {
        throw new Error(
          `[orcad-prebuilds] ${binary} is ${violation.actual}, expected ${process.arch}`
        )
      }
    }
    return { glibc: null }
  }
  floor.verifyLinuxGlibcFloor(slotDir, {
    targetArch: process.arch,
    glibcFloor: slotGlibcFloor(slot)
  })
  const objdump = process.env.OBJDUMP || 'objdump'
  const binaries = floor.collectNativeBinaries(slotDir)
  if (isCompatSlot(slot)) {
    for (const binary of binaries) {
      const shared = findSharedCxxRuntimeNeeds(
        floor.readDynamicInfo(binary, objdump).neededLibraries
      )
      if (shared.length > 0) {
        throw new Error(
          `[orcad-prebuilds] ${binary} needs ${shared.join(', ')}; the ${slot} slot must link its C++ runtime statically`
        )
      }
    }
  }
  return {
    glibc: highestGlibcNeed(binaries, (path) => floor.readDynamicInfo(path, objdump).versionNeeds)
  }
}

async function build() {
  const sourceDir = nodePtyDir()
  assertNodePtyPatchApplied(sourceDir)
  const slot = slotName()
  assertCompatSlotHost(slot, { platform: process.platform, arch: process.arch, libc: detectLibc() })
  const slotDir = join(PREBUILDS_DIR, slot)
  const { buildDir, nodeDir } = await compileNodePty(sourceDir, slot)
  const compatAddons = isCompatSlot(slot)
    ? await compileCompatAddons({ slot, workDir: join(WORK_DIR, slot), nodeDir })
    : []

  rmSync(slotDir, { recursive: true, force: true })
  const files = {}
  for (const [relative, source] of [
    ...slotSourceFiles({
      platform: process.platform,
      arch: process.arch,
      buildDir,
      nodePtyDir: sourceDir
    }),
    ...compatAddons
  ]) {
    if (!existsSync(source)) {
      throw new Error(`[orcad-prebuilds] ${slot} needs ${relative}, but ${source} is missing`)
    }
    const destination = join(slotDir, ...relative.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination)
    files[relative] = sha256Of(destination)
    if (relative.endsWith('.node')) {
      const newer = findPostBaselineNodeApiNames(readFileSync(destination))
      if (newer.length > 0) {
        throw new Error(
          `[orcad-prebuilds] ${slot}/${relative} imports ${newer.join(', ')}, above N-API ${SLOT_NAPI_VERSION}; host Node 18 could not load it`
        )
      }
    }
    console.log(`[orcad-prebuilds] stored ${slot}/${relative}`)
  }

  const libc = detectLibc()
  const { glibc } =
    process.platform === 'linux' ? linuxSlotRecord(slot, slotDir, libc) : { glibc: null }
  const manifest = mergeManifest(readManifest(PREBUILDS_DIR), {
    slot,
    version: require('node-pty/package.json').version,
    napi: SLOT_NAPI_VERSION,
    nodeHeaders: NODE_RUNTIME_PIN.version,
    entry: {
      platform: process.platform,
      arch: process.arch,
      libc,
      glibc,
      napi: SLOT_NAPI_VERSION,
      files
    }
  })
  writeFileSync(join(PREBUILDS_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `[orcad-prebuilds] manifest: node-pty ${manifest.version}, N-API ${manifest.napi}, ` +
      `slots ${Object.keys(manifest.slots).join(', ')}`
  )
}

async function main() {
  if (process.argv.includes('--print-slot')) {
    console.log(slotName())
    return
  }
  if (process.argv.includes('--print-runtime')) {
    console.log(await ensurePinnedNodeExecutable({ target: slotName() }))
    return
  }
  const slots = requestedSlots()
  if (slots) {
    requireSlots(slots)
    return
  }
  if (process.argv.includes('--smoke')) {
    const { runOrcadPrebuildSmoke } = await import('./orcad-prebuild-smoke.mjs')
    await runOrcadPrebuildSmoke({ slot: slotName(), prebuildsDir: PREBUILDS_DIR })
    return
  }
  await build()
}

if (process.argv[1] && process.argv[1].endsWith('build-orcad-prebuilds.mjs')) {
  await main()
}
