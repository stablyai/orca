// Slot manifests bind N-API/libc/glibc floor and file hashes to node-pty-prebuilt-slot.ts; N-API lets pinned and host Node share binaries (D2/D6).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

export const MANIFEST_SCHEMA_VERSION = 2

// Pin N-API 8 so a Node header bump cannot silently raise the shipped addon ABI.
export const SLOT_NAPI_VERSION = 8

/** The one export every Node-API addon may carry; any other `node_api_*` name is a post-8 import. */
const NODE_API_EXPORTS = new Set(['node_api_module_get_api_version_v1'])

// Opt-in compat slots use pinned Node and static libstdc++ because glibc 2.17 hosts only have GCC 4.8-era runtime.
export const COMPAT_SLOTS = Object.freeze({
  'linux-x64-glibc217': Object.freeze({ platform: 'linux', arch: 'x64', libc: 'glibc' })
})

// Map compat-built addons into orcad paths; a compat target must ship no native file from the base build.
export const COMPAT_SLOT_ADDONS = Object.freeze({
  'parcel-watcher/watcher.node': 'node_modules/@parcel/watcher/watcher.node'
})

// Find native files missing compat replacements: base-target binaries require newer glibc/libstdc++ than the compat host.
export function findCompatAddonGaps(targetFilenames, compatSources) {
  return targetFilenames.filter((file) => file.endsWith('.node') && !compatSources.has(file))
}

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

// Pin NAPI_VERSION and macOS gnu++20: official headers set clang:0, bypassing common.gypi and leaving old Apple clang on C++98.
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

// Post-N-API-8 functions use node_api_*; import names remain ASCII in ELF/Mach-O/PE. Exclude the standard module export.
export function findPostBaselineNodeApiNames(binary) {
  const names = new Set(binary.toString('latin1').match(/node_api_[A-Za-z0-9_]+/g) ?? [])
  return [...names].filter((name) => !NODE_API_EXPORTS.has(name)).sort()
}

const WINDOWS_WINPTY_FILES = ['pty.node', 'winpty.dll', 'winpty-agent.exe']

// Windows source build emits only conpty.node; vendor DLL/OpenConsole payload must sit beside it as on desktop.
// Keep upstream conpty_console_list for the non-DLL kill path and winpty binaries for Windows <18309 (10 1809/Server 2019); patch removes their build targets.
export function slotSourceFiles({ platform, arch, buildDir, nodePtyDir }) {
  if (platform === 'win32') {
    const conptyRuntime = windowsConptyRuntimeDir(nodePtyDir, arch)
    const upstream = join(nodePtyDir, 'prebuilds', `win32-${arch}`)
    return [
      ['conpty.node', join(buildDir, 'conpty.node')],
      ['conpty_console_list.node', join(upstream, 'conpty_console_list.node')],
      ['conpty/conpty.dll', join(conptyRuntime, 'conpty.dll')],
      ['conpty/OpenConsole.exe', join(conptyRuntime, 'OpenConsole.exe')],
      ...WINDOWS_WINPTY_FILES.map((file) => [file, join(upstream, file)])
    ]
  }
  // macOS posix_spawns spawn-helper and builds it only there; Linux forks directly.
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

// Merge per-runner slot records or the last runner erases the matrix; reject mixed node-pty/N-API versions.
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
    if (isCompatSlot(slot)) {
      for (const addon of Object.keys(COMPAT_SLOT_ADDONS)) {
        if (!Object.hasOwn(entry.files ?? {}, addon)) {
          problems.push(`${slot}/${addon}: not built`)
        }
      }
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
