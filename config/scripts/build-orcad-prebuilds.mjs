#!/usr/bin/env node
/**
 * Build one node-pty prebuilt for the CURRENT platform/arch/libc and file it in orcad's
 * prebuilds matrix, so a deployment target needs no C/C++ toolchain.
 *
 * node-pty is the only ABI-sensitive native module every slot builds; a compat slot also
 * builds the addons in COMPAT_SLOT_ADDONS (orcad-prebuild-compat-addons.mjs). node-pty is PATCHED in
 * this repo (config/patches/node-pty@1.1.0.patch), and that patch is the glibc-floor fix:
 * `.symver` pins on openpty/forkpty/pthread_sigmask plus the `--no-as-needed` ldflags that
 * keep libutil/libpthread in DT_NEEDED. An upstream prebuilt has none of it and reproduces
 * #9902. So the matrix is compiled from patched sources here, and this script refuses to
 * run if the patch is not in the tree it is about to compile.
 *
 * Compiled against the pinned Node's hash-verified headers (src/shared/node-runtime-pin.ts)
 * at N-API 8, so the matrix varies only platform/arch/libc (design D2):
 *   linux-{x64,arm64}-{glibc,musl}, darwin-{x64,arm64}, win32-{x64,arm64}
 *
 * CI runs this once per slot, each on the runner or container that owns that libc/arch, and
 * merges the resulting `out/orcad-prebuilds` trees. `--slot=<name>` forces the label so
 * the glibc/musl distinction is recorded from the container rather than detected.
 * glibc slots are built on glibc 2.28 and gated there, not at the desktop's 2.31 (design D6);
 * the opt-in `linux-x64-glibc217` compat slot (COMPAT_SLOTS) is built on glibc 2.17.
 *
 * Usage:
 *   node config/scripts/build-orcad-prebuilds.mjs [--slot=linux-x64-musl]
 *   node config/scripts/build-orcad-prebuilds.mjs --require-slots [slot,slot]  # release gate
 *   node config/scripts/build-orcad-prebuilds.mjs [--slot=...] --smoke  # load + spawn under the pinned Node
 *   node config/scripts/build-orcad-prebuilds.mjs --print-slot
 *   node config/scripts/build-orcad-prebuilds.mjs [--slot=...] --print-runtime  # fetch + print the slot's pinned Node
 */
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

/**
 * Why the report header and not `ldd`: `glibcVersionRuntime` is present only when the
 * process is linked against glibc, and musl images have no `ldd` worth parsing.
 */
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

/**
 * The patch is what holds the Ubuntu 20.04 floor. Compiling without it produces a binary
 * that loads fine on the build host and dies on the target — the exact failure the matrix
 * exists to prevent, now baked into a shipped artifact instead of a first-connect error.
 */
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
        'A prebuilt compiled without it will not load on Ubuntu 20.04 (see',
        'docs/reference/linux-glibc-compatibility.md and #9902). Run `pnpm install` to apply patches.'
      ].join('\n')
    )
  }
}

const GLIBC_DT_NEEDED_LDFLAG = "'-Wl,--no-as-needed,-l:libutil.so.1,-l:libpthread.so.0,--as-needed'"

/**
 * musl has no libutil.so.1 (openpty/forkpty live in libc and libutil is an empty static stub),
 * so the patch's glibc DT_NEEDED ldflag cannot link there.
 */
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

/**
 * The patch's `.symver` pins bind openpty/forkpty/pthread_sigmask to `@GLIBC_*` versions, which
 * musl's unversioned libc cannot satisfy at link time; musl never defines __GLIBC__.
 */
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

/**
 * Compile in a scratch copy, never in node_modules/node-pty: that tree holds the Electron
 * build the desktop loads, and a Node-headers rebuild there would break the app.
 */
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

/**
 * Linux-only gates: architecture always; the slot's glibc/libstdc++ floor and the recorded
 * glibc need only for glibc slots, since a musl slot never meets glibc's libraries.
 */
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
