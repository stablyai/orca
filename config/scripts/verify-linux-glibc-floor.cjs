const { readdirSync, openSync, readSync, closeSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, relative } = require('node:path')

// Why: v1.4.150 shipped a Linux build whose node-pty pty.node required
// GLIBC_2.34 (openpty/forkpty were relocated into libc by glibc's
// libutil/libpthread merge), so the app crashed on startup on Ubuntu 20.04
// (glibc 2.31) — the runner image silently bumped the build-host glibc. This
// gate fails Linux packaging if any bundled native binary requires a glibc (or
// libstdc++) symbol version newer than stock Ubuntu 20.04 ships, so a future
// runner bump or dependency change cannot reintroduce the regression unnoticed.
// See docs/reference/linux-glibc-compatibility.md.
const MIN_GLIBC = Object.freeze([2, 31])

// The symbol-version families this gate checks, each with the highest version
// node stock Ubuntu 20.04 provides. glibc is the #9902 launch-crash axis;
// libstdc++ (GLIBCXX_/CXXABI_) is the same crash class for C++ native modules
// against the system libstdc++ (Orca does not bundle one).
const VERSION_FLOORS = Object.freeze([
  Object.freeze({ prefix: 'GLIBC_', floor: MIN_GLIBC }),
  Object.freeze({ prefix: 'GLIBCXX_', floor: Object.freeze([3, 4, 28]) }),
  Object.freeze({ prefix: 'CXXABI_', floor: Object.freeze([1, 3, 12]) })
])
const FLOOR_LABEL = 'Ubuntu 20.04 (glibc 2.31 / libstdc++ GLIBCXX_3.4.28)'

// Why: the sherpa-onnx speech prebuilt is a third-party manylinux binary that
// already requires GLIBCXX_3.4.29 (GCC 11 / Ubuntu 21.10+, 22.04 LTS). It loads
// lazily in the speech worker (src/main/speech/stt-worker.ts), never at app
// launch, so it cannot cause the #9902 startup crash. Exempt it from the
// libstdc++ floor (its glibc is still gated) rather than fail the release on a
// pre-existing, non-launch condition — speech needs libstdc++ >= GCC 11.
const LIBSTDCXX_FLOOR_EXEMPT = /(?:^|[/\\])sherpa-onnx/

// VER_FLG_WEAK: a version need whose references are all weak. The loader
// tolerates its absence (resolves to null and the caller's fallback runs)
// instead of refusing to load, so a weak need must not count as a requirement.
const VER_FLG_WEAK = 0x2

/** Parse a "2.34" / "3.4.28" version string into a numeric tuple. */
function parseGlibcVersion(versionStr) {
  return versionStr.split('.').map((part) => Number.parseInt(part, 10))
}

/** Compare two numeric version tuples; missing trailing parts are 0. */
function compareGlibcVersions(a, b) {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) {
      return diff < 0 ? -1 : 1
    }
  }
  return 0
}

/**
 * Parse `objdump -p` "Version References" (the ELF `.gnu.version_r` section)
 * into the version nodes this binary requires from each shared library. This is
 * the authoritative load-time requirement list: unlike the dynamic symbol table
 * (`objdump -T`), it also captures symbol-less ABI markers such as
 * `GLIBC_ABI_DT_RELR` (packed relative relocations, glibc 2.36+) that still
 * block loading on an older glibc. Each entry: `0xHASH 0xFLAGS <n> <NAME>`.
 */
function parseVersionNeeds(objdumpOutput) {
  const needs = []
  let library = null
  let inSection = false
  for (const line of objdumpOutput.split('\n')) {
    if (line.startsWith('Version References:')) {
      inSection = true
      continue
    }
    if (!inSection) {
      continue
    }
    // Any new non-indented line ends the Version References block.
    if (!/^\s/.test(line)) {
      inSection = false
      continue
    }
    const libraryMatch = line.match(/^\s+required from (\S+):/)
    if (libraryMatch) {
      library = libraryMatch[1]
      continue
    }
    const entryMatch = line.match(/^\s+0x[0-9a-fA-F]+\s+0x([0-9a-fA-F]+)\s+\d+\s+(\S+)/)
    if (entryMatch) {
      const flags = Number.parseInt(entryMatch[1], 16)
      needs.push({ library, name: entryMatch[2], weak: (flags & VER_FLG_WEAK) !== 0 })
    }
  }
  return needs
}

/**
 * Whether a version node is newer than the floor Ubuntu 20.04 provides. Numeric
 * nodes (`GLIBC_2.34`, `GLIBCXX_3.4.29`) compare by version. Any non-numeric
 * glibc node is rejected: `GLIBC_ABI_DT_RELR` is a 2.36+ marker, and
 * `GLIBC_PRIVATE` is not a stable ABI contract — its symbols differ across
 * glibc releases, so a binary needing one can fail to load on the floor even
 * though the version node itself exists (a well-formed addon needs neither).
 * Named libstdc++ nodes (`CXXABI_TM_1`, `GLIBCXX_LDBL_*`) ship on 20.04.
 * Families we do not gate (`GCC_`, `NSS_`) return false.
 */
function isVersionNodeAboveFloor(name) {
  for (const { prefix, floor } of VERSION_FLOORS) {
    if (!name.startsWith(prefix)) {
      continue
    }
    const rest = name.slice(prefix.length)
    if (/^[0-9]+(?:\.[0-9]+)*$/.test(rest)) {
      return compareGlibcVersions(parseGlibcVersion(rest), floor) > 0
    }
    // Non-numeric suffix: reject every glibc node (ABI markers and PRIVATE).
    return prefix === 'GLIBC_'
  }
  return false
}

function isLibstdcxxNode(name) {
  return name.startsWith('GLIBCXX_') || name.startsWith('CXXABI_')
}

/**
 * Version needs from `filePath` that would prevent loading on the floor OS.
 * `sherpa-onnx` is exempt from the libstdc++ floor (see LIBSTDCXX_FLOOR_EXEMPT)
 * but its glibc needs are still checked.
 */
function findFloorViolations(needs, filePath = '') {
  const exemptLibstdcxx = LIBSTDCXX_FLOOR_EXEMPT.test(filePath)
  return needs.filter(
    (need) =>
      !need.weak &&
      isVersionNodeAboveFloor(need.name) &&
      !(exemptLibstdcxx && isLibstdcxxNode(need.name))
  )
}

// On stock Ubuntu 20.04 (glibc 2.31) these symbols live ONLY in these DSOs —
// glibc kept openpty/forkpty in libutil until the 2.34 merge. A binary that
// imports them must keep the DSO in DT_NEEDED or they will not resolve on the
// floor. This guards config/patches/node-pty@1.1.0.patch's forced
// `-l:libutil.so.1`: if a toolchain change ever dropped that ldflag, the pinned
// openpty@GLIBC_2.2.5 would still resolve from libc's compat alias at build time
// (so the version-floor check passes) yet fail to load on 20.04. libpthread
// (pthread_sigmask) is intentionally omitted — the Node/Electron host always
// loads it, so it resolves regardless of this addon's DT_NEEDED.
const RELOCATED_SYMBOL_PROVIDERS = Object.freeze({
  openpty: 'libutil.so.1',
  forkpty: 'libutil.so.1'
})

/**
 * Relocated symbols the binary imports whose providing DSO is absent from
 * DT_NEEDED — meaning they resolve at build time but not on the floor OS.
 */
function findMissingProviderDeps(importedSymbols, neededLibraries) {
  const missing = []
  for (const [symbol, library] of Object.entries(RELOCATED_SYMBOL_PROVIDERS)) {
    if (importedSymbols.has(symbol) && !neededLibraries.has(library)) {
      missing.push({ symbol, library })
    }
  }
  return missing
}

function isElfFile(filePath) {
  let fd
  try {
    fd = openSync(filePath, 'r')
    const header = Buffer.alloc(4)
    const bytesRead = readSync(fd, header, 0, 4, 0)
    return bytesRead === 4 && header[0] === 0x7f && header.toString('latin1', 1, 4) === 'ELF'
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

/** Recursively collect ELF native binaries (`.node`, `.so[.N]`, executables). */
function collectNativeBinaries(rootDir) {
  const binaries = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      // Why: .node/.so are always native; extensionless files (the Electron
      // executable, chrome-sandbox) are checked via the ELF magic so we cover
      // every launch-critical binary without objdump-ing app.asar or assets.
      const looksNative = entry.name.endsWith('.node') || /\.so(\.\d+)*$/.test(entry.name)
      if (looksNative || !entry.name.includes('.')) {
        if (isElfFile(fullPath)) {
          binaries.push(fullPath)
        }
      }
    }
  }
  walk(rootDir)
  return binaries.sort()
}

function resolveObjdump(explicitPath) {
  const candidates = [explicitPath, 'objdump', 'llvm-objdump'].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', env: cLocaleEnv() })
    if (!probe.error && probe.status === 0) {
      return candidate
    }
  }
  return null
}

// Why: GNU objdump localizes its section headers ("Version References:") via
// gettext, and the parser anchors on the English text. Force the C locale so
// output stays deterministic on non-English packaging hosts (LC_ALL=C also
// disables LANGUAGE-based message translation).
function cLocaleEnv() {
  return { ...process.env, LC_ALL: 'C', LANG: 'C' }
}

/**
 * Run objdump with one flag on `filePath`. Fail-closed: a spawn error, non-zero
 * exit, or signal throws, because a silently-unreadable binary (truncated,
 * corrupt, or an objdump that cannot decode its format) would let a too-new
 * binary slip past the gate.
 */
function runObjdump(objdumpPath, flag, filePath) {
  const result = spawnSync(objdumpPath, [flag, filePath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: cLocaleEnv()
  })
  if (result.error) {
    throw new Error(
      `[verify-linux-glibc-floor] could not run objdump on ${filePath}: ${result.error.message}`
    )
  }
  if (result.signal || result.status !== 0) {
    throw new Error(
      `[verify-linux-glibc-floor] objdump ${flag} failed for ${filePath} ` +
        `(status ${result.status}, signal ${result.signal ?? 'none'}): ${(result.stderr || '').trim()}`
    )
  }
  return result.stdout || ''
}

/** DT_NEEDED shared-library names from `objdump -p` (`  NEEDED  <lib>`). */
function parseNeededLibraries(objdumpOutput) {
  const needed = new Set()
  for (const line of objdumpOutput.split('\n')) {
    const match = line.match(/^\s+NEEDED\s+(\S+)/)
    if (match) {
      needed.add(match[1])
    }
  }
  return needed
}

/** Undefined (imported) dynamic symbol base names from `objdump -T` (`*UND*`). */
function parseImportedSymbols(objdumpOutput) {
  const imported = new Set()
  for (const line of objdumpOutput.split('\n')) {
    if (!line.includes('*UND*')) {
      continue
    }
    // The symbol name is the final token; strip any @VERSION suffix.
    const token = line.trim().split(/\s+/).pop()
    if (token) {
      imported.add(token.split('@')[0])
    }
  }
  return imported
}

/** Version needs + DT_NEEDED from a single `objdump -p` (fail-closed). */
function readDynamicInfo(filePath, objdumpPath) {
  const output = runObjdump(objdumpPath, '-p', filePath)
  return {
    versionNeeds: parseVersionNeeds(output),
    neededLibraries: parseNeededLibraries(output)
  }
}

/** Imported (undefined) dynamic symbols from `objdump -T` (fail-closed). */
function readImportedSymbols(filePath, objdumpPath) {
  return parseImportedSymbols(runObjdump(objdumpPath, '-T', filePath))
}

/**
 * Fail Linux packaging if any bundled native binary under `rootDir` requires a
 * glibc/libstdc++ symbol version newer than the floor OS. No-op is not allowed
 * on Linux: a missing objdump throws, because a silent skip would defeat the
 * regression gate on exactly the host where it matters.
 */
function verifyLinuxGlibcFloor(rootDir, options = {}) {
  const binaries = collectNativeBinaries(rootDir)
  if (binaries.length === 0) {
    console.log(`[verify-linux-glibc-floor] OK — no bundled native binaries under ${rootDir}`)
    return
  }

  // Why: resolve objdump only once there is something to inspect, so a fixture
  // with no ELF binaries does not fail on a host that lacks binutils.
  const objdumpPath = resolveObjdump(options.objdumpPath)
  if (!objdumpPath) {
    throw new Error(
      '[verify-linux-glibc-floor] objdump not found. Install binutils on the Linux ' +
        'packaging host so the glibc-floor gate can inspect bundled native binaries.'
    )
  }

  const offenders = []
  for (const filePath of binaries) {
    const { versionNeeds, neededLibraries } = readDynamicInfo(filePath, objdumpPath)
    const floorViolations = findFloorViolations(versionNeeds, filePath)
    // Only pay for `objdump -T` when a relocated-symbol provider is not already
    // in DT_NEEDED (the common, healthy case short-circuits without it).
    const providerViolations = Object.values(RELOCATED_SYMBOL_PROVIDERS).some(
      (library) => !neededLibraries.has(library)
    )
      ? findMissingProviderDeps(readImportedSymbols(filePath, objdumpPath), neededLibraries)
      : []
    if (floorViolations.length > 0 || providerViolations.length > 0) {
      offenders.push({ filePath, floorViolations, providerViolations })
    }
  }

  if (offenders.length > 0) {
    const detail = offenders
      .map(({ filePath, floorViolations, providerViolations }) => {
        const reasons = []
        if (floorViolations.length > 0) {
          const nodes = [...new Set(floorViolations.map((v) => v.name))].sort()
          const libraries = [...new Set(floorViolations.map((v) => v.library).filter(Boolean))]
          reasons.push(
            `needs ${nodes.join(', ')}${libraries.length > 0 ? ` (from ${libraries.join(', ')})` : ''}`
          )
        }
        for (const { symbol, library } of providerViolations) {
          reasons.push(`imports ${symbol} but ${library} is not in DT_NEEDED`)
        }
        return `  ${relative(rootDir, filePath) || filePath} ${reasons.join('; ')}`
      })
      .join('\n')
    throw new Error(
      `[verify-linux-glibc-floor] ${offenders.length} bundled native binar${offenders.length === 1 ? 'y' : 'ies'} ` +
        `will not load on ${FLOOR_LABEL}, so the app will crash on startup there:\n${detail}\n` +
        'See docs/reference/linux-glibc-compatibility.md — rebuild the offending module against an older ' +
        'toolchain or pin the relocated symbols (as config/patches/node-pty@1.1.0.patch does).'
    )
  }

  console.log(
    `[verify-linux-glibc-floor] OK — ${binaries.length} bundled native binaries all load on ${FLOOR_LABEL}`
  )
}

module.exports = {
  MIN_GLIBC,
  VERSION_FLOORS,
  FLOOR_LABEL,
  RELOCATED_SYMBOL_PROVIDERS,
  parseGlibcVersion,
  compareGlibcVersions,
  parseVersionNeeds,
  parseNeededLibraries,
  parseImportedSymbols,
  isVersionNodeAboveFloor,
  isLibstdcxxNode,
  findFloorViolations,
  findMissingProviderDeps,
  collectNativeBinaries,
  readDynamicInfo,
  readImportedSymbols,
  verifyLinuxGlibcFloor
}
