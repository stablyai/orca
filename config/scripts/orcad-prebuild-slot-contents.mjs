/**
 * What goes into one orcad node-pty prebuild slot, and the manifest that records it.
 *
 * The manifest is the loader's contract (src/main/orcad/node-pty-prebuilt-slot.ts): per-slot
 * N-API level, libc, the highest glibc symbol version the binaries need, and a sha256 per
 * shipped file. N-API rather than NODE_MODULE_VERSION is what lets one build serve the pinned
 * Node and a host Node (design D2/D6 rung C).
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

export const MANIFEST_SCHEMA_VERSION = 2

/**
 * Node 18, the rung C host floor, supports N-API 8 (9 only from 18.17). Pinned here rather
 * than left to the headers' default so a header bump cannot silently raise it.
 */
export const SLOT_NAPI_VERSION = 8

/** The one export every Node-API addon may carry; any other `node_api_*` name is a post-8 import. */
const NODE_API_EXPORTS = new Set(['node_api_module_get_api_version_v1'])

/**
 * Opt-in slots outside the default matrix, each beside its own pinned Node (design D6 rung B).
 * A glibc 2.17 host has no libstdc++ new enough for anything but GCC 4.8, so the compat slot
 * links it statically.
 */
export const COMPAT_SLOTS = Object.freeze({
  'linux-x64-glibc217': Object.freeze({ platform: 'linux', arch: 'x64', libc: 'glibc' })
})

export function isCompatSlot(slot) {
  return Object.hasOwn(COMPAT_SLOTS, slot)
}

/** The symbol-floor profile a glibc slot is gated at; the desktop keeps its own 2.31 floor. */
export function slotGlibcFloor(slot) {
  const floors = require('./verify-linux-glibc-floor.cjs')
  return isCompatSlot(slot) ? floors.COMPAT_SLOT_GLIBC_FLOOR : floors.SERVER_SLOT_GLIBC_FLOOR
}

/** Refuses a compat slot label on a host that cannot produce it, e.g. arm64 or musl. */
export function assertCompatSlotHost(slot, { platform, arch, libc }) {
  const expected = COMPAT_SLOTS[slot]
  if (
    expected &&
    (expected.platform !== platform || expected.arch !== arch || expected.libc !== libc)
  ) {
    throw new Error(
      `[orcad-prebuilds] ${slot} must be built on ${expected.platform}-${expected.arch}-${expected.libc}, ` +
        `not ${platform}-${arch}-${libc}`
    )
  }
}

const SHARED_CXX_RUNTIME = /^(?:libstdc\+\+\.so|libgcc_s\.so)/

/** DT_NEEDED entries that break a statically linked C++ runtime, e.g. libstdc++.so.6. */
export function findSharedCxxRuntimeNeeds(neededLibraries) {
  return [...neededLibraries].filter((name) => SHARED_CXX_RUNTIME.test(name)).sort()
}

/**
 * gyp include for every target node-gyp compiles: pins NAPI_VERSION, and on macOS the C++
 * standard, because the official headers' config.gypi says `clang: 0`, which skips
 * common.gypi's gnu++20 and leaves older Apple clang at its C++98 default.
 */
export function prebuildCompileGypi({ napi = SLOT_NAPI_VERSION, staticCxxRuntime = false } = {}) {
  const conditions = [
    [
      'OS=="mac"',
      {
        xcode_settings: {
          CLANG_CXX_LANGUAGE_STANDARD: 'gnu++20',
          CLANG_CXX_LIBRARY: 'libc++'
        }
      }
    ]
  ]
  if (staticCxxRuntime) {
    conditions.push(['OS=="linux"', { ldflags: ['-static-libstdc++', '-static-libgcc'] }])
  }
  const gypi = { target_defaults: { defines: [`NAPI_VERSION=${napi}`], conditions } }
  return `${JSON.stringify(gypi, null, 2)}\n`
}

/**
 * `node_api_*` symbol names in a binary other than the module export. Every function added
 * after N-API 8 uses that prefix (node_api_symbol_for, node_api_create_property_key_*, ...),
 * and import tables store names as plain ASCII in ELF, Mach-O and PE alike.
 */
export function findPostBaselineNodeApiNames(binary) {
  const names = new Set(binary.toString('latin1').match(/node_api_[A-Za-z0-9_]+/g) ?? [])
  return [...names].filter((name) => !NODE_API_EXPORTS.has(name)).sort()
}

/**
 * Files a slot ships, as `[slot-relative path, source path]`.
 *
 * Windows: the patched build is conpty.node only (the patch deletes the winpty `pty` and
 * `conpty_console_list` gyp targets). conpty.node loads `conpty/conpty.dll` beside itself,
 * which starts `OpenConsole.exe` from the same directory; both come from node-pty's
 * third_party payload, as rebuild-native-deps.mjs restores them for the desktop.
 * `conpty_console_list.node` is upstream's N-API prebuild, the same file the desktop keeps:
 * lib/conpty_console_list_agent.js loads it, but only on the non-DLL kill path, which Orca
 * never takes (it always passes useConptyDll on win32). Shipped so that path fails soft
 * rather than on a missing module.
 */
export function slotSourceFiles({ platform, arch, buildDir, nodePtyDir }) {
  if (platform === 'win32') {
    const conptyRuntime = windowsConptyRuntimeDir(nodePtyDir, arch)
    return [
      ['conpty.node', join(buildDir, 'conpty.node')],
      [
        'conpty_console_list.node',
        join(nodePtyDir, 'prebuilds', `win32-${arch}`, 'conpty_console_list.node')
      ],
      ['conpty/conpty.dll', join(conptyRuntime, 'conpty.dll')],
      ['conpty/OpenConsole.exe', join(conptyRuntime, 'OpenConsole.exe')]
    ]
  }
  // Why spawn-helper on macOS only: node-pty posix_spawns it there, and binding.gyp builds it
  // only under OS=="mac"; Linux forks directly.
  return [
    ['pty.node', join(buildDir, 'pty.node')],
    ...(platform === 'darwin' ? [['spawn-helper', join(buildDir, 'spawn-helper')]] : [])
  ]
}

/** The single versioned ConPTY payload node-pty vendors, e.g. third_party/conpty/1.23.251008001/win10-x64. */
export function windowsConptyRuntimeDir(nodePtyDir, arch) {
  const root = join(nodePtyDir, 'third_party', 'conpty')
  const versions = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && existsSync(join(root, entry.name, `win10-${arch}`))
        )
        .map((entry) => entry.name)
    : []
  if (versions.length !== 1) {
    throw new Error(
      `[orcad-prebuilds] expected exactly one ConPTY payload for win10-${arch} under ${root}, found ${versions.length}`
    )
  }
  return join(root, versions[0], `win10-${arch}`)
}

export function readManifest(prebuildsDir) {
  try {
    return JSON.parse(readFileSync(join(prebuildsDir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

export function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Highest strong `GLIBC_x.y` need across the slot's ELF binaries, e.g. '2.17'. */
export function highestGlibcNeed(binaryPaths, readVersionNeeds) {
  const { compareGlibcVersions, parseGlibcVersion } = require('./verify-linux-glibc-floor.cjs')
  let highest = null
  for (const path of binaryPaths) {
    for (const need of readVersionNeeds(path)) {
      const match = /^GLIBC_(\d+(?:\.\d+)*)$/.exec(need.name)
      if (!need.weak && match) {
        if (
          !highest ||
          compareGlibcVersions(parseGlibcVersion(match[1]), parseGlibcVersion(highest)) > 0
        ) {
          highest = match[1]
        }
      }
    }
  }
  return highest
}

/**
 * Why merge rather than overwrite: CI builds one slot per runner and merges the trees. A
 * manifest holding only the last slot would erase the others, and `--require-slots` would
 * reject a complete matrix. Mixing builds of different node-pty or N-API levels is refused.
 */
export function mergeManifest(existing, next) {
  const current = existing?.schemaVersion === MANIFEST_SCHEMA_VERSION ? existing : null
  if (current && (current.version !== next.version || current.napi !== next.napi)) {
    throw new Error(
      `[orcad-prebuilds] refusing to merge node-pty ${next.version}/N-API ${next.napi} into a ` +
        `manifest for ${current.version}/N-API ${current.napi}`
    )
  }
  const slots = { ...current?.slots, [next.slot]: next.entry }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    module: 'node-pty',
    version: next.version,
    napi: next.napi,
    nodeHeaders: next.nodeHeaders,
    slots: Object.fromEntries(Object.entries(slots).sort(([a], [b]) => a.localeCompare(b)))
  }
}

/** Problems with the named slots: absent, or a listed file missing or not matching its hash. */
export function findSlotProblems(manifest, prebuildsDir, requiredSlots) {
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return [`manifest.json is missing or not schema ${MANIFEST_SCHEMA_VERSION}`]
  }
  const problems = []
  for (const slot of requiredSlots) {
    const entry = manifest.slots?.[slot]
    if (!entry) {
      problems.push(`${slot}: not built`)
      continue
    }
    for (const [file, expected] of Object.entries(entry.files ?? {})) {
      const path = join(prebuildsDir, slot, ...file.split('/'))
      if (!existsSync(path)) {
        problems.push(`${slot}/${file}: missing`)
      } else if (sha256Of(path) !== expected) {
        problems.push(`${slot}/${file}: sha256 does not match the manifest`)
      }
    }
  }
  return problems
}
