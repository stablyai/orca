const { closeSync, fstatSync, openSync, readSync } = require('node:fs')
const { basename } = require('node:path')

const EXPECTED_ARCHITECTURE_BY_FILENAME = new Map([
  ['orca-linux.AppImage', 'x64'],
  ['orca-linux-arm64.AppImage', 'arm64']
])
const APPIMAGE_MAGIC = Buffer.from([0x41, 0x49, 0x02])
const RUNTIME_SOURCE = Buffer.from('https://github.com/AppImage/type2-runtime')
const TARGET_ARCHITECTURE_BY_ENUM = new Map([
  [1, 'x64'],
  [3, 'arm64']
])
const RUNTIME_ARCHITECTURE_BY_MACHINE = new Map([
  [0x3e, 'x64'],
  [0xb7, 'arm64']
])
const ELF_HEADER_BYTES = 64
const PROGRAM_HEADER_BYTES = 56
const DYNAMIC_ENTRY_BYTES = 16
const MAX_PROGRAM_HEADERS = 128
const MAX_LOAD_BYTES = 16 * 1024 * 1024
const MAX_DYNAMIC_BYTES = 1024 * 1024

function verifyStaticAppImagePackage(filePath, targetArch) {
  const filename = basename(filePath)
  const filenameArchitecture = EXPECTED_ARCHITECTURE_BY_FILENAME.get(filename)
  if (!filenameArchitecture) {
    invalid(
      filename,
      `unsupported artifact name; expected ${[...EXPECTED_ARCHITECTURE_BY_FILENAME.keys()].join(' or ')}`
    )
  }
  const targetArchitecture = normalizeTargetArchitecture(targetArch, filename)
  if (filenameArchitecture !== targetArchitecture) {
    invalid(
      filename,
      `artifact filename targets ${filenameArchitecture}, but electron-builder target is ${targetArchitecture}`
    )
  }

  const descriptor = openSync(filePath, 'r')
  try {
    const stats = fstatSync(descriptor, { bigint: true })
    if (process.platform !== 'win32' && (stats.mode & 0o111n) === 0n) {
      invalid(filename, 'artifact is not executable')
    }
    const fileSize = stats.size
    const header = readRange(
      descriptor,
      0n,
      BigInt(ELF_HEADER_BYTES),
      fileSize,
      filename,
      'ELF header'
    )
    const { entry, machine } = verifyElfHeader(header, filename)
    const runtimeArchitecture = RUNTIME_ARCHITECTURE_BY_MACHINE.get(machine)
    if (runtimeArchitecture !== targetArchitecture) {
      invalid(
        filename,
        `runtime architecture ${runtimeArchitecture ?? `machine 0x${machine.toString(16)}`} does not match electron-builder target ${targetArchitecture}`
      )
    }

    const programHeaderOffset = header.readBigUInt64LE(32)
    const programHeaderSize = header.readUInt16LE(54)
    const programHeaderCount = header.readUInt16LE(56)
    if (programHeaderSize !== PROGRAM_HEADER_BYTES) {
      invalid(filename, `unexpected ELF program-header size ${programHeaderSize}`)
    }
    if (programHeaderCount === 0 || programHeaderCount > MAX_PROGRAM_HEADERS) {
      invalid(filename, `invalid ELF program-header count ${programHeaderCount}`)
    }

    const tableSize = BigInt(programHeaderSize * programHeaderCount)
    const table = readRange(
      descriptor,
      programHeaderOffset,
      tableSize,
      fileSize,
      filename,
      'ELF program-header table'
    )
    const segments = parseProgramHeaders(table, programHeaderSize)
    verifySegments(descriptor, segments, fileSize, filename, entry)
  } finally {
    closeSync(descriptor)
  }
}

function verifyElfHeader(header, filename) {
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    invalid(filename, 'missing ELF magic')
  }
  if (header[4] !== 2 || header[5] !== 1 || header[6] !== 1) {
    invalid(filename, 'runtime must be ELF64 little-endian version 1')
  }
  if (!header.subarray(8, 11).equals(APPIMAGE_MAGIC)) {
    invalid(filename, 'missing type-2 AppImage marker')
  }
  if (header.readUInt16LE(16) !== 3) {
    invalid(filename, 'runtime must be an ET_DYN static PIE')
  }
  const machine = header.readUInt16LE(18)
  if (!RUNTIME_ARCHITECTURE_BY_MACHINE.has(machine)) {
    invalid(filename, `unsupported ELF machine 0x${machine.toString(16)}`)
  }
  if (header.readUInt32LE(20) !== 1) {
    invalid(filename, 'runtime has an unsupported ELF version')
  }
  if (header.readUInt16LE(52) !== ELF_HEADER_BYTES) {
    invalid(filename, `unexpected ELF header size ${header.readUInt16LE(52)}`)
  }
  return { entry: header.readBigUInt64LE(24), machine }
}

function parseProgramHeaders(table, entrySize) {
  const segments = []
  for (let offset = 0; offset < table.length; offset += entrySize) {
    segments.push({
      type: table.readUInt32LE(offset),
      flags: table.readUInt32LE(offset + 4),
      offset: table.readBigUInt64LE(offset + 8),
      virtualAddress: table.readBigUInt64LE(offset + 16),
      fileSize: table.readBigUInt64LE(offset + 32),
      memorySize: table.readBigUInt64LE(offset + 40)
    })
  }
  return segments
}

function verifySegments(descriptor, segments, fileSize, filename, entry) {
  if (segments.some((segment) => segment.type === 3)) {
    invalid(filename, 'runtime contains PT_INTERP')
  }

  const loadSegments = segments.filter((segment) => segment.type === 1)
  const totalLoadBytes = loadSegments.reduce((total, segment) => total + segment.fileSize, 0n)
  if (loadSegments.length === 0 || totalLoadBytes > BigInt(MAX_LOAD_BYTES)) {
    invalid(filename, `invalid or oversized PT_LOAD data (${totalLoadBytes} bytes)`)
  }
  if (
    !loadSegments.some(
      (segment) =>
        segment.flags & 1 &&
        entry >= segment.virtualAddress &&
        entry - segment.virtualAddress < segment.memorySize
    )
  ) {
    invalid(filename, 'ELF entry point is outside an executable PT_LOAD segment')
  }
  let identifiesStaticRuntime = false
  for (const segment of loadSegments) {
    verifyFileBackedSegment(segment, fileSize, filename, 'PT_LOAD')
    const data = readRange(
      descriptor,
      segment.offset,
      segment.fileSize,
      fileSize,
      filename,
      'PT_LOAD data'
    )
    identifiesStaticRuntime ||= data.includes(RUNTIME_SOURCE)
  }
  if (!identifiesStaticRuntime) {
    invalid(filename, `runtime does not identify ${RUNTIME_SOURCE.toString()}`)
  }

  for (const segment of segments.filter((entry) => entry.type === 2)) {
    verifyDynamicSegment(descriptor, segment, fileSize, filename)
  }
}

function normalizeTargetArchitecture(targetArch, filename) {
  const architecture =
    typeof targetArch === 'number' ? TARGET_ARCHITECTURE_BY_ENUM.get(targetArch) : targetArch
  if (architecture !== 'x64' && architecture !== 'arm64') {
    invalid(filename, `unsupported electron-builder target architecture ${String(targetArch)}`)
  }
  return architecture
}

function verifyFileBackedSegment(segment, fileSize, filename, label) {
  if (segment.memorySize < segment.fileSize) {
    invalid(filename, `${label} memory size is smaller than its file size`)
  }
  verifyRange(segment.offset, segment.fileSize, fileSize, filename, label)
}

function verifyDynamicSegment(descriptor, segment, fileSize, filename) {
  verifyFileBackedSegment(segment, fileSize, filename, 'PT_DYNAMIC')
  if (
    segment.fileSize === 0n ||
    segment.fileSize > BigInt(MAX_DYNAMIC_BYTES) ||
    segment.fileSize % BigInt(DYNAMIC_ENTRY_BYTES) !== 0n
  ) {
    invalid(filename, `invalid PT_DYNAMIC size ${segment.fileSize}`)
  }
  const dynamic = readRange(
    descriptor,
    segment.offset,
    segment.fileSize,
    fileSize,
    filename,
    'PT_DYNAMIC data'
  )
  let terminated = false
  for (let offset = 0; offset < dynamic.length; offset += DYNAMIC_ENTRY_BYTES) {
    const tag = dynamic.readBigInt64LE(offset)
    if (tag === 0n) {
      terminated = true
      break
    }
    if (tag === 1n) {
      invalid(filename, 'runtime contains a DT_NEEDED dependency')
    }
  }
  if (!terminated) {
    invalid(filename, 'PT_DYNAMIC is missing DT_NULL')
  }
}

function readRange(descriptor, offset, size, fileSize, filename, label) {
  verifyRange(offset, size, fileSize, filename, label)
  const buffer = Buffer.alloc(Number(size))
  let bytesRead = 0
  while (bytesRead < buffer.length) {
    const count = readSync(
      descriptor,
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      Number(offset) + bytesRead
    )
    if (count === 0) {
      throw new Error(`Unable to read complete ${label}`)
    }
    bytesRead += count
  }
  return buffer
}

function verifyRange(offset, size, fileSize, filename, label) {
  const maxSafeOffset = BigInt(Number.MAX_SAFE_INTEGER)
  if (
    offset > fileSize ||
    size > fileSize - offset ||
    offset > maxSafeOffset ||
    size > maxSafeOffset - offset
  ) {
    invalid(filename, `${label} is outside the artifact`)
  }
}

function invalid(filename, reason) {
  throw new Error(`Invalid static AppImage ${filename}: ${reason}`)
}

module.exports = { verifyStaticAppImagePackage }
