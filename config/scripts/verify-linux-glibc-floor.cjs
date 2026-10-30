const { readdirSync, openSync, readSync, closeSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, relative } = require('node:path')

// Gate bundled Linux binaries against Ubuntu 20.04 symbol floors to prevent native load crashes (#9902); see docs/reference/linux-glibc-compatibility.md.
const MIN_GLIBC = Object.freeze([2, 31])

// Gate glibc plus system libstdc++ ABI families; Orca bundles no C++ runtime for desktop.
const VERSION_FLOORS = Object.freeze([
  Object.freeze({ prefix: 'GLIBC_', floor: MIN_GLIBC }),
  Object.freeze({ prefix: 'GLIBCXX_', floor: Object.freeze([3, 4, 28]) }),
  Object.freeze({ prefix: 'CXXABI_', floor: Object.freeze([1, 3, 12]) })
])
const FLOOR_LABEL = 'Ubuntu 20.04 (glibc 2.31 / libstdc++ GLIBCXX_3.4.28)'

function glibcFloorProfile(label, glibc, glibcxx, cxxabi) {
  return Object.freeze({
    label,
    families: Object.freeze([
      Object.freeze({ prefix: 'GLIBC_', floor: Object.freeze(glibc) }),
      Object.freeze({ prefix: 'GLIBCXX_', floor: Object.freeze(glibcxx) }),
      Object.freeze({ prefix: 'CXXABI_', floor: Object.freeze(cxxabi) })
    ])
  })
}

/** The packaged desktop app's floor; the default for every check here. */
const DESKTOP_GLIBC_FLOOR = Object.freeze({ label: FLOOR_LABEL, families: VERSION_FLOORS })

// Server slots target pinned Node’s glibc 2.28 hosts, including RHEL8/Debian10 GCC8; desktop’s 2.31 floor would leave older hosts without terminals (D6).
const SERVER_SLOT_GLIBC_FLOOR = glibcFloorProfile(
  'glibc 2.28 (RHEL 8 / Debian 10, libstdc++ GLIBCXX_3.4.25)',
  [2, 28],
  [3, 4, 25],
  [1, 3, 11]
)

// The linux-x64-glibc217 compat slot beside the unofficial glibc-217 Node (design D6 rung B).
const COMPAT_SLOT_GLIBC_FLOOR = glibcFloorProfile(
  'glibc 2.17 (CentOS 7, libstdc++ GLIBCXX_3.4.19)',
  [2, 17],
  [3, 4, 19],
  [1, 3, 7]
)

// Lazy speech-worker sherpa prebuilt requires GCC11 GLIBCXX_3.4.29; exempt C++ floor only, retain glibc gate because it is not launch-critical.
const LIBSTDCXX_FLOOR_EXEMPT = /(?:^|[/\\])sherpa-onnx/

// VER_FLG_WEAK needs may resolve null and use fallback; they must not raise required floor.
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

// Read objdump -p Version References, not just symbols: symbol-less ABI markers (DT_RELR/glibc2.36) still block loader. Rows are 0xHASH 0xFLAGS <n> <NAME>.
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

// Compare numeric GLIBC/GLIBCXX/CXXABI versions; reject all nonnumeric GLIBC markers/private ABI. Named C++ ABI nodes ship on floor; unrelated families remain ungated.
function isVersionNodeAboveFloor(name, glibcFloor = DESKTOP_GLIBC_FLOOR) {
  for (const { prefix, floor } of glibcFloor.families) {
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

// Gate load-time requirements; exempt sherpa C++ needs only, never its glibc needs.
function findFloorViolations(needs, filePath = '', glibcFloor = DESKTOP_GLIBC_FLOOR) {
  const exemptLibstdcxx = LIBSTDCXX_FLOOR_EXEMPT.test(filePath)
  return needs.filter(
    (need) =>
      !need.weak &&
      isVersionNodeAboveFloor(need.name, glibcFloor) &&
      !(exemptLibstdcxx && isLibstdcxxNode(need.name))
  )
}

// Ubuntu20.04 keeps openpty/forkpty in libutil until glibc2.34 merge: require DT_NEEDED even when newer libc compat aliases satisfy link-time floor.
// Pins node-pty’s -l:libutil.so.1; omit pthread_sigmask because Node/Electron already loads libpthread.
const RELOCATED_SYMBOL_PROVIDERS = Object.freeze({
  openpty: 'libutil.so.1',
  forkpty: 'libutil.so.1'
})

// Require providing DSO in DT_NEEDED for relocated imports that newer build host could resolve from libc alias.
function findMissingProviderDeps(importedSymbols, neededLibraries) {
  const missing = []
  for (const [symbol, library] of Object.entries(RELOCATED_SYMBOL_PROVIDERS)) {
    if (importedSymbols.has(symbol) && !neededLibraries.has(library)) {
      missing.push({ symbol, library })
    }
  }
  return missing
}

// ELF e_machine values for the Linux slices we package. Names match electron-builder's Arch enum.
const ELF_MACHINE_BY_ARCH = Object.freeze({ x64: 0x3e, arm64: 0xb7 })
const ARCH_BY_ELF_MACHINE = Object.freeze({ 0x3e: 'x64', 0xb7: 'arm64' })

// Read little-endian ELF machine separately: cross-build can ship host-arch addon whose symbol floors pass but target cannot load.
function readElfMachine(filePath) {
  let fd
  try {
    fd = openSync(filePath, 'r')
    const header = Buffer.alloc(20)
    if (readSync(fd, header, 0, 20, 0) !== 20) {
      return null
    }
    // EI_DATA (offset 5) must be ELFDATA2LSB for a little-endian e_machine read.
    if (header[5] !== 1) {
      return null
    }
    return header.readUInt16LE(18)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

// Arch tokens that appear in vendored per-architecture package/directory names.
const ARCH_TOKEN_PATTERN = /(?:^|[^a-z0-9])(arm64|aarch64|x64|x86_64)(?:[^a-z0-9]|$)/i
const ARCH_BY_TOKEN = Object.freeze({ arm64: 'arm64', aarch64: 'arm64', x64: 'x64', x86_64: 'x64' })

// Judge multi-arch vendored binaries by declared path architecture; valid arm64 watcher may intentionally ship inside x64 slice.
function declaredArchFromPath(filePath) {
  const match = ARCH_TOKEN_PATTERN.exec(filePath)
  return match ? ARCH_BY_TOKEN[match[1].toLowerCase()] : null
}

function findArchViolation(filePath, targetArch, rootDir) {
  // Judge declared payload arch, not slice; use relative paths so outer linux-arm64-unpacked directory cannot label every file arm64.
  const declared = declaredArchFromPath(rootDir ? relative(rootDir, filePath) : filePath)
  const expectedArch = declared ?? targetArch
  const expected = ELF_MACHINE_BY_ARCH[expectedArch]
  if (expected === undefined) {
    return null
  }
  const machine = readElfMachine(filePath)
  if (machine === null || machine === expected) {
    return null
  }
  return {
    machine,
    actual: ARCH_BY_ELF_MACHINE[machine] ?? `0x${machine.toString(16)}`,
    expectedArch,
    declared: declared !== null
  }
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
      // Inspect .node/.so and ELF-magic executables; skip asar/assets without invoking objdump.
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

// Force C locale/LC_ALL to keep objdump’s gettext-translated section headers parseable, including hosts with LANGUAGE set.
function cLocaleEnv() {
  return { ...process.env, LC_ALL: 'C', LANG: 'C' }
}

// Fail closed on objdump spawn/exit/signal errors: unreadable/truncated/unsupported binary must not pass floor check.
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
  const versionNeeds = parseVersionNeeds(output)
  const neededLibraries = parseNeededLibraries(output)
  return {
    versionNeeds,
    neededLibraries,
    // LLVM prints an empty Dynamic Section even for static executables.
    isStatic:
      /^Program Header:/m.test(output) &&
      /^\s+LOAD\s+off\s+0x[0-9a-f]+/m.test(output) &&
      !/^\s+(?:DYNAMIC|INTERP)\s+off\s+/m.test(output) &&
      versionNeeds.length === 0 &&
      neededLibraries.size === 0
  }
}

function isMuslTemplatePayload(filePath, neededLibraries, versionNeeds) {
  return (
    /(?:^|[/\\])orcad-template[/\\]targets[/\\]linux-(?:x64|arm64)-musl[/\\]/.test(filePath) &&
    [...neededLibraries].some(
      (name) => name === 'libc.so' || /^libc\.musl-[\w-]+\.so\.1$/.test(name)
    ) &&
    ![...neededLibraries, ...versionNeeds.map((need) => need.library)].some((name) =>
      /^(?:libc\.so\.6|libm\.so\.6|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1|ld-linux.*)$/.test(
        name
      )
    )
  )
}

/** Imported (undefined) dynamic symbols from `objdump -T` (fail-closed). */
function readImportedSymbols(filePath, objdumpPath) {
  return parseImportedSymbols(runObjdump(objdumpPath, '-T', filePath))
}

// Gate all native binaries under root with selected/default desktop floor; missing objdump on Linux must throw rather than silently skip.
function verifyLinuxGlibcFloor(rootDir, options = {}) {
  const binaries = collectNativeBinaries(rootDir)
  const targetArch = options.targetArch
  const glibcFloor = options.glibcFloor ?? DESKTOP_GLIBC_FLOOR
  if (binaries.length === 0) {
    console.log(`[verify-linux-glibc-floor] OK — no bundled native binaries under ${rootDir}`)
    return
  }

  // Resolve objdump only when ELF files exist so empty fixtures work without binutils.
  const objdumpPath = resolveObjdump(options.objdumpPath)
  if (!objdumpPath) {
    throw new Error(
      '[verify-linux-glibc-floor] objdump not found. Install binutils on the Linux ' +
        'packaging host so the glibc-floor gate can inspect bundled native binaries.'
    )
  }

  // Reject wrong architecture before version inspection; its valid symbol versions cannot establish target compatibility.
  const archOffenders = binaries
    .map((filePath) => ({ filePath, violation: findArchViolation(filePath, targetArch, rootDir) }))
    .filter(({ violation }) => violation !== null)
  if (archOffenders.length > 0) {
    const detail = archOffenders
      .map(
        ({ filePath, violation }) =>
          `  ${relative(rootDir, filePath) || filePath} is ${violation.actual}, expected ` +
          `${violation.expectedArch}${violation.declared ? ' (from its own path)' : ''}`
      )
      .join('\n')
    throw new Error(
      `[verify-linux-glibc-floor] ${archOffenders.length} bundled native binar` +
        `${archOffenders.length === 1 ? 'y is' : 'ies are'} built for the wrong architecture ` +
        `(target ${targetArch}), so the app will fail to load them at runtime:\n${detail}\n` +
        'Cross-building a Linux slice can pack the host architecture despite a forced rebuild; ' +
        'build this slice on a native runner.'
    )
  }

  const offenders = []
  for (const filePath of binaries) {
    const { versionNeeds, neededLibraries, isStatic } = readDynamicInfo(filePath, objdumpPath)
    const isMuslTarget = isMuslTemplatePayload(filePath, neededLibraries, versionNeeds)
    // Remote musl payloads use their host's C++ runtime, not Ubuntu's libstdc++ or libutil.
    const floorViolations = findFloorViolations(versionNeeds, filePath, glibcFloor).filter(
      (need) => !isMuslTarget || !isLibstdcxxNode(need.name)
    )
    // Inspect dynamic symbols only if relocated provider is absent from DT_NEEDED; healthy case avoids extra objdump.
    const providerViolations =
      !isStatic &&
      !isMuslTarget &&
      Object.values(RELOCATED_SYMBOL_PROVIDERS).some((library) => !neededLibraries.has(library))
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
        `will not load on ${glibcFloor.label}, so the app will crash on startup there:\n${detail}\n` +
        'See docs/reference/linux-glibc-compatibility.md — rebuild the offending module against an older ' +
        'toolchain or pin the relocated symbols (as config/patches/node-pty@1.1.0.patch does).'
    )
  }

  console.log(
    `[verify-linux-glibc-floor] OK — ${binaries.length} bundled native binaries meet applicable ${glibcFloor.label} requirements`
  )
}

module.exports = {
  MIN_GLIBC,
  ELF_MACHINE_BY_ARCH,
  readElfMachine,
  declaredArchFromPath,
  findArchViolation,
  VERSION_FLOORS,
  FLOOR_LABEL,
  DESKTOP_GLIBC_FLOOR,
  SERVER_SLOT_GLIBC_FLOOR,
  COMPAT_SLOT_GLIBC_FLOOR,
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
