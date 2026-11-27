const { existsSync, readFileSync, realpathSync, statSync, writeFileSync } = require('node:fs')
const { basename, dirname, extname, join, resolve } = require('node:path')
const {
  MONTEREY_MINIMUM_SYSTEM_VERSION,
  forEachMachOLoadCommand,
  lowerExecutableMinimumOs,
  lowerMachOMinimumOsInBuffer,
  machOSlices,
  writeMachOBinaryAtomically
} = require('./macos-monterey-executable-minimum-os.cjs')

const MONTEREY_LOCAL_ENV = 'ORCA_MAC_MONTEREY_LOCAL'
const MONTEREY_ELECTRON_DIST_ENV = 'ORCA_MAC_MONTEREY_ELECTRON_DIST'
const MONTEREY_DIST_MARKER_FILENAME = '.orca-monterey-weak-imports'
const MONTEREY_WEAK_IMPORT_ALLOWLIST = Object.freeze([
  '_OBJC_CLASS_$_SMAppService',
  '_kVTCompressionPropertyKey_ReferenceBufferCount',
  '_OBJC_CLASS_$_NSPreviewRepresentingActivityItem'
])

const LC_DYLD_CHAINED_FIXUPS = 0x80000034
const FIXUPS_HEADER_SIZE = 28
const IMPORT_STRIDES = { 1: 4, 2: 8, 3: 16 }

function assertMontereyFlagAllowed(env = process.env) {
  if (env[MONTEREY_LOCAL_ENV] !== '1') {
    return
  }
  const conflicts = Object.entries({
    ORCA_MAC_RELEASE: ['1'],
    ORCA_MAC_HOURLY: ['1'],
    ORCA_MAC_DAILY: ['1'],
    ORCA_MAC_ADHOC: ['1'],
    ORCA_BUILD_IDENTITY: ['stable', 'rc'],
    CI: ['1', 'true'],
    GITHUB_ACTIONS: ['true']
  })
    .filter(([key, values]) => values.includes(env[key]))
    .map(([key]) => key)
  if (conflicts.length > 0) {
    throw new Error(`${MONTEREY_LOCAL_ENV}=1 conflicts with ${conflicts.join(', ')}.`)
  }
}

function isMacMontereyLocalBuild(env = process.env) {
  assertMontereyFlagAllowed(env)
  return env[MONTEREY_LOCAL_ENV] === '1'
}

function resolveMontereyElectronDistDir(
  env = process.env,
  repoRoot = resolve(__dirname, '../../../..')
) {
  const dist = env[MONTEREY_ELECTRON_DIST_ENV]
  if (!dist) {
    throw new Error(`Set ${MONTEREY_ELECTRON_DIST_ENV} to the local Electron dist directory.`)
  }
  const { devDependencies } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const zip = `electron-v${devDependencies.electron}-darwin-x64.zip`
  const distPath = resolve(repoRoot, dist)
  if (
    !statSync(distPath, { throwIfNoEntry: false })?.isDirectory() ||
    !statSync(join(distPath, zip), { throwIfNoEntry: false })?.isFile()
  ) {
    throw new Error(
      `${MONTEREY_ELECTRON_DIST_ENV} must point to a directory containing ${zip}: ${distPath}`
    )
  }
  return distPath
}

function resolveElectronFrameworkBinary(targetPath) {
  const target = resolve(targetPath)
  if (statSync(target).isFile()) {
    return { binaryPath: realpathSync(target), distRoot: null }
  }
  const app = extname(target) === '.app' ? target : join(target, 'Electron.app')
  const parent = dirname(app)
  const distRoot =
    basename(app) === 'Electron.app' && existsSync(join(parent, 'version'))
      ? realpathSync(parent)
      : null
  const framework = 'Electron Framework'
  const binaryPath = realpathSync(
    join(app, 'Contents', 'Frameworks', `${framework}.framework`, framework)
  )
  return { binaryPath, distRoot }
}

function resolvePackagedAppMainExecutable(targetPath) {
  const target = resolve(targetPath)
  if (
    !statSync(target).isDirectory() ||
    extname(target) !== '.app' ||
    basename(target) === 'Electron.app'
  ) {
    return null
  }
  let executableName = basename(target, '.app')
  const infoPlistPath = join(target, 'Contents', 'Info.plist')
  if (existsSync(infoPlistPath)) {
    const match = readFileSync(infoPlistPath, 'utf8').match(
      /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/
    )
    if (match?.[1]?.trim()) {
      executableName = match[1].trim()
    }
  }
  return realpathSync(join(target, 'Contents', 'MacOS', executableName))
}

function locateChainedFixups(buffer, slice) {
  const { offset, size } = slice
  let dataOffset = 0
  let dataSize = 0
  forEachMachOLoadCommand(buffer, slice, ({ command, commandSize, cursor }) => {
    if (command === LC_DYLD_CHAINED_FIXUPS) {
      if (commandSize < 16) {
        throw new Error(`Truncated LC_DYLD_CHAINED_FIXUPS at offset ${cursor}.`)
      }
      dataOffset = buffer.readUInt32LE(cursor + 8)
      dataSize = buffer.readUInt32LE(cursor + 12)
    }
  })
  if (dataSize < FIXUPS_HEADER_SIZE || dataOffset + dataSize > size) {
    throw new Error(`Missing or invalid LC_DYLD_CHAINED_FIXUPS in slice at offset ${offset}.`)
  }
  return { start: offset + dataOffset, size: dataSize }
}

function collectSliceImports(buffer, slice, allowlist, alreadyWeak, strongImports) {
  const { start, size } = locateChainedFixups(buffer, slice)
  const version = buffer.readUInt32LE(start)
  const importsOffset = buffer.readUInt32LE(start + 8)
  const symbolsOffset = buffer.readUInt32LE(start + 12)
  const importsCount = buffer.readUInt32LE(start + 16)
  const importsFormat = buffer.readUInt32LE(start + 20)
  const symbolsFormat = buffer.readUInt32LE(start + 24)
  const stride = IMPORT_STRIDES[importsFormat]
  if (version !== 0 || !stride || symbolsFormat !== 0) {
    throw new Error(
      `Unsupported chained fixups version or format in slice at offset ${slice.offset}.`
    )
  }
  if (importsOffset + importsCount * stride > size || symbolsOffset > size) {
    throw new Error(`Chained fixups table exceeds slice data at offset ${start}.`)
  }
  const isWideImport = importsFormat === 3
  const missing = new Set(allowlist)
  const data = buffer.subarray(start, start + size)
  for (let i = 0; i < importsCount; i++) {
    const pos = importsOffset + i * stride
    const nameOffset = isWideImport
      ? Number(data.readBigUInt64LE(pos) >> 32n)
      : data.readUInt32LE(pos) >>> 9
    const nameStart = symbolsOffset + nameOffset
    const nul = data.indexOf(0, nameStart)
    if (nameStart >= size || nul === -1) {
      throw new Error(`Invalid chained import symbol name at offset ${start + nameStart}.`)
    }
    const name = data.toString('utf8', nameStart, nul)
    if (allowlist.has(name)) {
      missing.delete(name)
      const weakByte = start + pos + (isWideImport ? 2 : 1)
      if ((buffer[weakByte] & 1) !== 0) {
        alreadyWeak.push(name)
      } else {
        strongImports.push({ name, weakByte })
      }
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `Missing allowlisted imports in slice at offset ${slice.offset}: ${[...missing].join(', ')}.`
    )
  }
}

function weakenChainedFixupImportsInBuffer(
  buffer,
  { allowlist = MONTEREY_WEAK_IMPORT_ALLOWLIST, verifyOnly = false } = {}
) {
  const slices = machOSlices(buffer)
  const allowlistSet = new Set(allowlist)
  const alreadyWeak = []
  const strongImports = []
  for (const slice of slices) {
    collectSliceImports(buffer, slice, allowlistSet, alreadyWeak, strongImports)
  }
  const weakened = strongImports.map(({ name }) => name)
  if (verifyOnly && weakened.length > 0) {
    throw new Error(`Allowlisted imports still strong: ${weakened.join(', ')}.`)
  }
  for (const { weakByte } of strongImports) {
    buffer[weakByte] |= 1
  }
  return { changed: weakened.length > 0, slices: slices.length, weakened, alreadyWeak }
}

function weakenElectronFrameworkImports(
  targetPath,
  { verifyOnly = false, writeDistMarker = false } = {}
) {
  const { binaryPath, distRoot } = resolveElectronFrameworkBinary(targetPath)
  if (!verifyOnly && writeDistMarker && distRoot === null) {
    throw new Error(
      `Cannot write ${MONTEREY_DIST_MARKER_FILENAME}: ${targetPath} is not an unpackaged Electron dist.`
    )
  }
  const buffer = readFileSync(binaryPath)
  const result = weakenChainedFixupImportsInBuffer(buffer, { verifyOnly })
  if (verifyOnly) {
    return { binaryPath, distRoot, ...result }
  }
  // Mark the dist before exposing patched bytes so a failed swap cannot make it cacheable.
  if (writeDistMarker) {
    writeFileSync(join(distRoot, MONTEREY_DIST_MARKER_FILENAME), 'monterey-weak-imports-v1\n')
  }
  if (result.changed) {
    writeMachOBinaryAtomically(binaryPath, buffer)
  }
  return { binaryPath, distRoot, ...result }
}

if (require.main === module) {
  try {
    const [operation, target, ...extra] = process.argv.slice(2)
    if ((operation !== '--apply' && operation !== '--verify') || !target || extra.length > 0) {
      throw new Error(`Usage: ${basename(__filename)} (--apply | --verify) <path>`)
    }
    const verifyOnly = operation === '--verify'
    const { changed, slices, weakened, alreadyWeak } = weakenElectronFrameworkImports(target, {
      verifyOnly,
      writeDistMarker: !verifyOnly && Boolean(resolveElectronFrameworkBinary(target).distRoot)
    })
    const packagedExecutable = verifyOnly ? resolvePackagedAppMainExecutable(target) : null
    const minosSuffix = packagedExecutable
      ? `, mainExecutableMinos=${lowerExecutableMinimumOs(packagedExecutable, { verifyOnly: true }).previous.join(',')}`
      : ''
    console.log(
      `changed=${changed}, slices=${slices}, weakened=${weakened.length}, alreadyWeak=${alreadyWeak.length}${minosSuffix}`
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = {
  MONTEREY_LOCAL_ENV,
  MONTEREY_ELECTRON_DIST_ENV,
  MONTEREY_MINIMUM_SYSTEM_VERSION,
  MONTEREY_DIST_MARKER_FILENAME,
  MONTEREY_WEAK_IMPORT_ALLOWLIST,
  assertMontereyFlagAllowed,
  isMacMontereyLocalBuild,
  resolveMontereyElectronDistDir,
  resolveElectronFrameworkBinary,
  weakenChainedFixupImportsInBuffer,
  weakenElectronFrameworkImports,
  lowerMachOMinimumOsInBuffer,
  lowerExecutableMinimumOs,
  resolvePackagedAppMainExecutable
}
