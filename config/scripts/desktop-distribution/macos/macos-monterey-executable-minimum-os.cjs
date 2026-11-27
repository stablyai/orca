const {
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { basename, resolve } = require('node:path')

const MONTEREY_MINIMUM_SYSTEM_VERSION = '12.0'
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const MH_MAGIC_64 = 0xfeedfacf
const LC_CODE_SIGNATURE = 0x1d
const LC_BUILD_VERSION = 0x32
const MACH_HEADER_SIZE = 32
const BUILD_VERSION_MIN_SIZE = 24
const MACHO_PLATFORM_MACOS = 1

function encodeMachOVersion(version) {
  const match = typeof version === 'string' && /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version)
  if (!match) {
    throw new Error('Expected a Mach-O version in major.minor or major.minor.patch format.')
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3] ?? '0')
  if (major > 0xffff || minor > 0xff || patch > 0xff) {
    throw new Error(`Mach-O version exceeds field limits: ${version}.`)
  }
  return ((major << 16) | (minor << 8) | patch) >>> 0
}

function formatMachOVersion(encoded) {
  return `${encoded >>> 16}.${(encoded >>> 8) & 0xff}.${encoded & 0xff}`
}

function machOSlices(buffer) {
  if (buffer.length < MACH_HEADER_SIZE) {
    throw new Error('Mach-O header is truncated.')
  }
  const magic = buffer.readUInt32BE(0)
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    return [{ offset: 0, size: buffer.length }]
  }
  const isFat64 = magic === FAT_MAGIC_64
  const entrySize = isFat64 ? 32 : 20
  const count = buffer.readUInt32BE(4)
  if (count === 0 || 8 + count * entrySize > buffer.length) {
    throw new Error('Invalid fat Mach-O slice table.')
  }
  const slices = []
  for (let i = 0; i < count; i++) {
    const entry = 8 + i * entrySize
    const offset = isFat64
      ? Number(buffer.readBigUInt64BE(entry + 8))
      : buffer.readUInt32BE(entry + 8)
    const size = isFat64
      ? Number(buffer.readBigUInt64BE(entry + 16))
      : buffer.readUInt32BE(entry + 12)
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      size < MACH_HEADER_SIZE ||
      offset + size > buffer.length
    ) {
      throw new Error(`Invalid Mach-O slice bounds for slice ${i}.`)
    }
    slices.push({ offset, size })
  }
  return slices
}

function forEachMachOLoadCommand(
  buffer,
  { offset, size },
  onCommand,
  { allowCodeSignature = false } = {}
) {
  if (buffer.readUInt32LE(offset) !== MH_MAGIC_64) {
    throw new Error(`Expected a little-endian 64-bit Mach-O slice at offset ${offset}.`)
  }
  const commandCount = buffer.readUInt32LE(offset + 16)
  let cursor = offset + MACH_HEADER_SIZE
  const commandsEnd = cursor + buffer.readUInt32LE(offset + 20)
  if (commandsEnd > offset + size) {
    throw new Error(`Mach-O load commands exceed slice at offset ${offset}.`)
  }
  for (let i = 0; i < commandCount; i++) {
    if (cursor + 8 > commandsEnd) {
      throw new Error(`Truncated Mach-O load command at offset ${cursor}.`)
    }
    const command = buffer.readUInt32LE(cursor)
    const commandSize = buffer.readUInt32LE(cursor + 4)
    if (commandSize < 8 || cursor + commandSize > commandsEnd) {
      throw new Error(`Invalid Mach-O load command size at offset ${cursor}.`)
    }
    if (!allowCodeSignature && command === LC_CODE_SIGNATURE) {
      throw new Error(
        `Mach-O slice at offset ${offset} carries LC_CODE_SIGNATURE; signed binaries and arm64 slices are unsupported.`
      )
    }
    onCommand({ command, commandSize, cursor })
    cursor += commandSize
  }
}

function writeMachOBinaryAtomically(binaryPath, buffer) {
  const mode = statSync(binaryPath).mode & 0o777
  const tmpPath = `${binaryPath}.monterey-tmp-${process.pid}`
  try {
    writeFileSync(tmpPath, buffer, { mode })
    chmodSync(tmpPath, mode)
    renameSync(tmpPath, binaryPath)
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {}
    throw error
  }
}

function lowerMachOMinimumOsInBuffer(
  buffer,
  { minimumSystemVersion = MONTEREY_MINIMUM_SYSTEM_VERSION, verifyOnly = false } = {}
) {
  const targetMinos = encodeMachOVersion(minimumSystemVersion)
  const slices = machOSlices(buffer)
  const entries = []

  // Validate every slice before editing so a later failure leaves the buffer intact.
  for (const slice of slices) {
    let entry
    forEachMachOLoadCommand(
      buffer,
      slice,
      ({ command, commandSize, cursor }) => {
        if (command !== LC_BUILD_VERSION) {
          return
        }
        if (commandSize < BUILD_VERSION_MIN_SIZE) {
          throw new Error(`Truncated LC_BUILD_VERSION at offset ${cursor}.`)
        }
        const ntools = buffer.readUInt32LE(cursor + 20)
        if (BUILD_VERSION_MIN_SIZE + ntools * 8 > commandSize) {
          throw new Error(`LC_BUILD_VERSION tools exceed command size at offset ${cursor}.`)
        }
        if (entry) {
          throw new Error(`Duplicate LC_BUILD_VERSION in Mach-O slice at offset ${slice.offset}.`)
        }
        const platform = buffer.readUInt32LE(cursor + 8)
        if (platform !== MACHO_PLATFORM_MACOS) {
          throw new Error(
            `Expected macOS LC_BUILD_VERSION platform (1) in slice at offset ${slice.offset}, got ${platform}.`
          )
        }
        const minosOffset = cursor + 12
        entry = { minosOffset, currentMinos: buffer.readUInt32LE(minosOffset) }
      },
      { allowCodeSignature: verifyOnly }
    )
    if (!entry) {
      throw new Error(`Missing LC_BUILD_VERSION in Mach-O slice at offset ${slice.offset}.`)
    }
    entries.push(entry)
  }

  const previous = entries.map(({ currentMinos }) => formatMachOVersion(currentMinos))
  const aboveTarget = entries.filter(({ currentMinos }) => currentMinos > targetMinos)
  if (verifyOnly) {
    if (aboveTarget.length > 0) {
      throw new Error(
        `Mach-O LC_BUILD_VERSION minos exceeds ${formatMachOVersion(targetMinos)}: ${aboveTarget.map(({ currentMinos }) => formatMachOVersion(currentMinos)).join(', ')}.`
      )
    }
    return { changed: false, slices: slices.length, previous }
  }
  for (const { minosOffset } of aboveTarget) {
    buffer.writeUInt32LE(targetMinos, minosOffset)
  }
  return { changed: aboveTarget.length > 0, slices: slices.length, previous }
}

function lowerExecutableMinimumOs(
  executablePath,
  { minimumSystemVersion = MONTEREY_MINIMUM_SYSTEM_VERSION, verifyOnly = false } = {}
) {
  const binaryPath = realpathSync(resolve(executablePath))
  if (!statSync(binaryPath).isFile()) {
    throw new Error(`Expected a Mach-O executable file at ${binaryPath}.`)
  }
  const buffer = readFileSync(binaryPath)
  const result = lowerMachOMinimumOsInBuffer(buffer, { minimumSystemVersion, verifyOnly })
  if (!verifyOnly && result.changed) {
    writeMachOBinaryAtomically(binaryPath, buffer)
  }
  return { binaryPath, ...result }
}

if (require.main === module) {
  try {
    const [operation, target, ...extra] = process.argv.slice(2)
    if ((operation !== '--apply' && operation !== '--verify') || !target || extra.length > 0) {
      throw new Error(`Usage: ${basename(__filename)} (--apply | --verify) <executablePath>`)
    }
    const { changed, slices, previous } = lowerExecutableMinimumOs(target, {
      verifyOnly: operation === '--verify'
    })
    const targetVersion = formatMachOVersion(encodeMachOVersion(MONTEREY_MINIMUM_SYSTEM_VERSION))
    console.log(
      `changed=${changed}, slices=${slices}, previous=${previous.join(',')}, target=${targetVersion}`
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = {
  MONTEREY_MINIMUM_SYSTEM_VERSION,
  LC_BUILD_VERSION,
  MACHO_PLATFORM_MACOS,
  encodeMachOVersion,
  formatMachOVersion,
  machOSlices,
  forEachMachOLoadCommand,
  writeMachOBinaryAtomically,
  lowerMachOMinimumOsInBuffer,
  lowerExecutableMinimumOs
}
