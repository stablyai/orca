import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { resolve } from 'node:path'

const MAX_PE_BYTES = 64 * 1024 * 1024
const MAX_HEADER_BYTES = 1024 * 1024
const MAX_SECTIONS = 96
const MAX_DEBUG_ENTRIES = 32
const MAX_DIFF_RANGES = 128
const MAX_HEADER_DIFFERENCES = 128
const MAX_RANGE_SAMPLE_BYTES = 32
const MAX_REGION_SAMPLES = 8
const READ_CHUNK_BYTES = 64 * 1024
const DIAGNOSTIC_TIMEOUT_MS = 60_000

const DATA_DIRECTORY_NAMES = [
  'export',
  'import',
  'resource',
  'exception',
  'security',
  'baseRelocation',
  'debug',
  'architecture',
  'globalPointer',
  'tls',
  'loadConfig',
  'boundImport',
  'iat',
  'delayImport',
  'clr',
  'reserved'
]

function requireBytes(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > buffer.length) {
    throw new Error(`PE ${label} exceeds the bounded header`)
  }
}

function hex(value, width = 0) {
  return `0x${value.toString(16).padStart(width, '0')}`
}

function readSectionName(buffer, offset) {
  const bytes = buffer.subarray(offset, offset + 8)
  const end = bytes.indexOf(0)
  const name = bytes.subarray(0, end === -1 ? bytes.length : end).toString('ascii')
  return /^[ -~]*$/.test(name) ? name : bytes.toString('hex')
}

function parsePeHeader(buffer) {
  requireBytes(buffer, 0, 0x40, 'DOS header')
  if (buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('PE diagnostic input is missing the MZ signature')
  }
  const peOffset = buffer.readUInt32LE(0x3c)
  requireBytes(buffer, peOffset, 24, 'COFF header')
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('PE diagnostic input is missing the PE signature')
  }

  const coffOffset = peOffset + 4
  const numberOfSections = buffer.readUInt16LE(coffOffset + 2)
  const optionalHeaderBytes = buffer.readUInt16LE(coffOffset + 16)
  if (numberOfSections > MAX_SECTIONS) {
    throw new Error('PE section count exceeds the diagnostic limit')
  }
  const optionalOffset = coffOffset + 20
  requireBytes(buffer, optionalOffset, optionalHeaderBytes, 'optional header')
  const magic = buffer.readUInt16LE(optionalOffset)
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`unsupported PE optional-header magic: ${hex(magic, 4)}`)
  }
  const pe32Plus = magic === 0x20b
  const directoryCountOffset = optionalOffset + (pe32Plus ? 108 : 92)
  const directoryOffset = optionalOffset + (pe32Plus ? 112 : 96)
  requireBytes(buffer, directoryCountOffset, 4, 'data-directory count')
  const declaredDirectoryCount = buffer.readUInt32LE(directoryCountOffset)
  const availableDirectoryCount = Math.floor(
    (optionalOffset + optionalHeaderBytes - directoryOffset) / 8
  )
  const directoryCount = Math.min(declaredDirectoryCount, availableDirectoryCount, 16)
  const dataDirectories = {}
  for (let index = 0; index < directoryCount; index += 1) {
    const offset = directoryOffset + index * 8
    dataDirectories[DATA_DIRECTORY_NAMES[index]] = {
      virtualAddress: hex(buffer.readUInt32LE(offset), 8),
      size: buffer.readUInt32LE(offset + 4)
    }
  }

  const sectionTableOffset = optionalOffset + optionalHeaderBytes
  requireBytes(buffer, sectionTableOffset, numberOfSections * 40, 'section table')
  const sections = []
  for (let index = 0; index < numberOfSections; index += 1) {
    const offset = sectionTableOffset + index * 40
    sections.push({
      name: readSectionName(buffer, offset),
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawPointer: buffer.readUInt32LE(offset + 20),
      characteristics: hex(buffer.readUInt32LE(offset + 36), 8),
      headerOffset: offset
    })
  }

  const imageBase = pe32Plus
    ? hex(buffer.readBigUInt64LE(optionalOffset + 24), 16)
    : hex(buffer.readUInt32LE(optionalOffset + 28), 8)
  const header = {
    dos: { peOffset },
    coff: {
      machine: hex(buffer.readUInt16LE(coffOffset), 4),
      numberOfSections,
      timeDateStamp: hex(buffer.readUInt32LE(coffOffset + 4), 8),
      pointerToSymbolTable: buffer.readUInt32LE(coffOffset + 8),
      numberOfSymbols: buffer.readUInt32LE(coffOffset + 12),
      optionalHeaderBytes,
      characteristics: hex(buffer.readUInt16LE(coffOffset + 18), 4)
    },
    optional: {
      magic: hex(magic, 4),
      linkerVersion: `${buffer[optionalOffset + 2]}.${buffer[optionalOffset + 3]}`,
      sizeOfCode: buffer.readUInt32LE(optionalOffset + 4),
      sizeOfInitializedData: buffer.readUInt32LE(optionalOffset + 8),
      sizeOfUninitializedData: buffer.readUInt32LE(optionalOffset + 12),
      addressOfEntryPoint: hex(buffer.readUInt32LE(optionalOffset + 16), 8),
      imageBase,
      sectionAlignment: buffer.readUInt32LE(optionalOffset + 32),
      fileAlignment: buffer.readUInt32LE(optionalOffset + 36),
      sizeOfImage: buffer.readUInt32LE(optionalOffset + 56),
      sizeOfHeaders: buffer.readUInt32LE(optionalOffset + 60),
      checksum: hex(buffer.readUInt32LE(optionalOffset + 64), 8),
      subsystem: hex(buffer.readUInt16LE(optionalOffset + 68), 4),
      dllCharacteristics: hex(buffer.readUInt16LE(optionalOffset + 70), 4),
      declaredDirectoryCount,
      dataDirectories
    },
    sections: sections.map(({ headerOffset: _headerOffset, ...section }) => section),
    debugDirectory: []
  }
  const regions = [
    { start: coffOffset, end: coffOffset + 20, label: 'COFF header' },
    { start: optionalOffset, end: optionalOffset + optionalHeaderBytes, label: 'optional header' },
    ...sections.map((section) => ({
      start: section.headerOffset,
      end: section.headerOffset + 40,
      label: `section header ${section.name}`
    })),
    ...sections
      .filter((section) => section.rawSize > 0)
      .map((section) => ({
        start: section.rawPointer,
        end: section.rawPointer + section.rawSize,
        label: `section ${section.name}`
      }))
  ]
  return { header, regions, sections }
}

function regionAt(regions, offset) {
  const matches = regions.filter((region) => offset >= region.start && offset < region.end)
  matches.sort((left, right) => left.end - left.start - (right.end - right.start))
  return matches[0]?.label ?? 'unmapped file data'
}

function bytesHex(bytes) {
  return bytes
    .map((byte) => (byte === undefined ? '--' : byte.toString(16).padStart(2, '0')))
    .join('')
}

function rangeRecord(state, firstRegions, secondRegions) {
  const firstRegion = regionAt(firstRegions, state.start)
  const secondRegion = regionAt(secondRegions, state.start)
  return {
    start: state.start,
    endExclusive: state.end,
    startHex: hex(state.start),
    endExclusiveHex: hex(state.end),
    length: state.end - state.start,
    firstRegion,
    secondRegion,
    firstBytes: bytesHex(state.firstBytes),
    secondBytes: bytesHex(state.secondBytes),
    bytesTruncated: state.end - state.start > state.firstBytes.length
  }
}

function addRegionSummary(state, range) {
  const key = `${range.firstRegion}\0${range.secondRegion}`
  let summary = state.regionSummaries.get(key)
  if (!summary) {
    summary = {
      firstRegion: range.firstRegion,
      secondRegion: range.secondRegion,
      differingBytes: 0,
      rangeCount: 0,
      firstOffset: range.start,
      lastEndExclusive: range.endExclusive,
      samples: []
    }
    state.regionSummaries.set(key, summary)
  }
  summary.differingBytes += range.length
  summary.rangeCount += 1
  summary.lastEndExclusive = range.endExclusive
  if (summary.samples.length < MAX_REGION_SAMPLES) {
    summary.samples.push({
      start: range.start,
      endExclusive: range.endExclusive,
      firstBytes: range.firstBytes,
      secondBytes: range.secondBytes,
      bytesTruncated: range.bytesTruncated
    })
  }
}

function rvaToFileOffset(rva, header, sections) {
  if (rva < header.optional.sizeOfHeaders) {
    return rva
  }
  const section = sections.find(
    (candidate) =>
      rva >= candidate.virtualAddress &&
      rva < candidate.virtualAddress + Math.max(candidate.virtualSize, candidate.rawSize)
  )
  if (!section) {
    return undefined
  }
  const delta = rva - section.virtualAddress
  return delta < section.rawSize ? section.rawPointer + delta : undefined
}

async function readAt(handle, offset, length, fileSize, signal) {
  signal.throwIfAborted()
  if (offset < 0 || length < 0 || offset + length > fileSize) {
    throw new Error('PE diagnostic read exceeds the file boundary')
  }
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    signal.throwIfAborted()
    const result = await handle.read(buffer, read, length - read, offset + read)
    if (result.bytesRead === 0) {
      throw new Error('PE diagnostic encountered an early EOF')
    }
    read += result.bytesRead
  }
  return buffer
}

async function addDebugDirectory(handle, parsed, fileSize, signal) {
  const debug = parsed.header.optional.dataDirectories.debug
  if (!debug || debug.size === 0) {
    return
  }
  const debugRva = Number.parseInt(debug.virtualAddress.slice(2), 16)
  const debugOffset = rvaToFileOffset(debugRva, parsed.header, parsed.sections)
  if (debugOffset === undefined || debug.size % 28 !== 0) {
    throw new Error('PE debug directory does not map to complete entries')
  }
  const entryCount = debug.size / 28
  if (entryCount > MAX_DEBUG_ENTRIES) {
    throw new Error('PE debug directory exceeds the diagnostic entry limit')
  }
  const bytes = await readAt(handle, debugOffset, debug.size, fileSize, signal)
  parsed.regions.push({
    start: debugOffset,
    end: debugOffset + debug.size,
    label: 'debug directory'
  })
  for (let index = 0; index < entryCount; index += 1) {
    const offset = index * 28
    const entry = {
      characteristics: hex(bytes.readUInt32LE(offset), 8),
      timeDateStamp: hex(bytes.readUInt32LE(offset + 4), 8),
      version: `${bytes.readUInt16LE(offset + 8)}.${bytes.readUInt16LE(offset + 10)}`,
      type: bytes.readUInt32LE(offset + 12),
      sizeOfData: bytes.readUInt32LE(offset + 16),
      addressOfRawData: hex(bytes.readUInt32LE(offset + 20), 8),
      pointerToRawData: bytes.readUInt32LE(offset + 24)
    }
    if (entry.type === 2 && entry.sizeOfData > 0 && entry.sizeOfData <= 4096) {
      const codeView = await readAt(
        handle,
        entry.pointerToRawData,
        entry.sizeOfData,
        fileSize,
        signal
      )
      const signature = codeView.subarray(0, Math.min(4, codeView.length)).toString('ascii')
      const pathStart = signature === 'RSDS' && codeView.length >= 24 ? 24 : 4
      const pathBytes = codeView.subarray(pathStart)
      entry.codeView = {
        signature,
        identifier: signature === 'RSDS' ? codeView.subarray(4, 20).toString('hex') : undefined,
        age: signature === 'RSDS' ? codeView.readUInt32LE(20) : undefined,
        pathBytes: pathBytes.length,
        pathSha256: `sha256:${createHash('sha256').update(pathBytes).digest('hex')}`
      }
      parsed.regions.push({
        start: entry.pointerToRawData,
        end: entry.pointerToRawData + entry.sizeOfData,
        label: `CodeView data ${index}`
      })
    }
    parsed.header.debugDirectory.push(entry)
  }
}

async function inspectPe(path, label, signal) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} PE input must be a regular file`)
  }
  if (metadata.size > MAX_PE_BYTES) {
    throw new Error(`${label} PE input exceeds the diagnostic size limit`)
  }
  const handle = await open(path, 'r')
  try {
    const prefix = await readAt(
      handle,
      0,
      Math.min(metadata.size, MAX_HEADER_BYTES),
      metadata.size,
      signal
    )
    const parsed = parsePeHeader(prefix)
    await addDebugDirectory(handle, parsed, metadata.size, signal)
    return { handle, metadata, parsed }
  } catch (error) {
    await handle.close()
    throw error
  }
}

function finishRange(state, firstRegions, secondRegions) {
  if (state.start === undefined) {
    return
  }
  state.rangeCount += 1
  const range = rangeRecord(state, firstRegions, secondRegions)
  addRegionSummary(state, range)
  if (state.ranges.length < MAX_DIFF_RANGES) {
    state.ranges.push(range)
  }
  state.start = undefined
  state.firstBytes = []
  state.secondBytes = []
}

async function compareBytes(first, second, signal) {
  const firstHash = createHash('sha256')
  const secondHash = createHash('sha256')
  const state = {
    differingBytes: 0,
    end: 0,
    firstBytes: [],
    rangeCount: 0,
    ranges: [],
    regionSummaries: new Map(),
    secondBytes: [],
    start: undefined
  }
  const length = Math.max(first.metadata.size, second.metadata.size)
  for (let offset = 0; offset < length; offset += READ_CHUNK_BYTES) {
    signal.throwIfAborted()
    const firstLength = Math.min(READ_CHUNK_BYTES, Math.max(0, first.metadata.size - offset))
    const secondLength = Math.min(READ_CHUNK_BYTES, Math.max(0, second.metadata.size - offset))
    const [firstBytes, secondBytes] = await Promise.all([
      readAt(first.handle, offset, firstLength, first.metadata.size, signal),
      readAt(second.handle, offset, secondLength, second.metadata.size, signal)
    ])
    firstHash.update(firstBytes)
    secondHash.update(secondBytes)
    const chunkLength = Math.max(firstLength, secondLength)
    for (let index = 0; index < chunkLength; index += 1) {
      const different =
        index >= firstLength || index >= secondLength || firstBytes[index] !== secondBytes[index]
      if (different) {
        state.differingBytes += 1
        if (state.start === undefined) {
          state.start = offset + index
          state.firstBytes = []
          state.secondBytes = []
        }
        if (state.firstBytes.length < MAX_RANGE_SAMPLE_BYTES) {
          state.firstBytes.push(index < firstLength ? firstBytes[index] : undefined)
          state.secondBytes.push(index < secondLength ? secondBytes[index] : undefined)
        }
        state.end = offset + index + 1
      } else {
        finishRange(state, first.parsed.regions, second.parsed.regions)
      }
    }
  }
  finishRange(state, first.parsed.regions, second.parsed.regions)
  return {
    firstSha256: `sha256:${firstHash.digest('hex')}`,
    secondSha256: `sha256:${secondHash.digest('hex')}`,
    differingBytes: state.differingBytes,
    rangeCount: state.rangeCount,
    ranges: state.ranges,
    rangesTruncated: state.rangeCount > state.ranges.length,
    regionSummaries: [...state.regionSummaries.values()]
  }
}

function collectHeaderDifferences(first, second, path, state) {
  if (state.count >= MAX_HEADER_DIFFERENCES) {
    state.truncated = true
    return
  }
  if (Object.is(first, second)) {
    return
  }
  if (
    first === null ||
    second === null ||
    typeof first !== 'object' ||
    typeof second !== 'object'
  ) {
    state.differences.push({ field: path, first: first ?? null, second: second ?? null })
    state.count += 1
    return
  }
  const keys = [...new Set([...Object.keys(first), ...Object.keys(second)])].sort()
  for (const key of keys) {
    collectHeaderDifferences(first[key], second[key], path ? `${path}.${key}` : key, state)
  }
}

export async function diagnoseWindowsPeMismatch({
  firstPePath,
  secondPePath,
  signal = AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS)
}) {
  const firstPath = resolve(firstPePath)
  const secondPath = resolve(secondPePath)
  if (firstPath === secondPath) {
    throw new Error('PE diagnostic inputs must be distinct files')
  }
  signal.throwIfAborted()
  const first = await inspectPe(firstPath, 'first', signal)
  let second
  try {
    second = await inspectPe(secondPath, 'second', signal)
    const comparison = await compareBytes(first, second, signal)
    const headerState = { count: 0, differences: [], truncated: false }
    collectHeaderDifferences(first.parsed.header, second.parsed.header, '', headerState)
    return {
      schemaVersion: 1,
      first: {
        bytes: first.metadata.size,
        sha256: comparison.firstSha256,
        pe: first.parsed.header
      },
      second: {
        bytes: second.metadata.size,
        sha256: comparison.secondSha256,
        pe: second.parsed.header
      },
      difference: {
        differingBytes: comparison.differingBytes,
        rangeCount: comparison.rangeCount,
        ranges: comparison.ranges,
        rangesTruncated: comparison.rangesTruncated,
        regionSummaries: comparison.regionSummaries,
        headerDifferences: headerState.differences,
        headerDifferencesTruncated: headerState.truncated
      }
    }
  } finally {
    await Promise.all([first.handle.close(), second?.handle.close()])
  }
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parseWindowsPeDiagnosticArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = valueAfter(argv, index, flag)
    if (flag === '--first-pe') {
      result.firstPePath = value
    } else if (flag === '--second-pe') {
      result.secondPePath = value
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
    index += 1
  }
  for (const field of ['firstPePath', 'secondPePath']) {
    if (!result[field]) {
      throw new Error(`Missing required PE diagnostic argument: ${field}`)
    }
  }
  return result
}

async function main() {
  const result = await diagnoseWindowsPeMismatch(
    parseWindowsPeDiagnosticArguments(process.argv.slice(2))
  )
  process.stdout.write(`windows_pe_mismatch=${JSON.stringify(result)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    process.stderr.write(`Windows PE mismatch diagnostic failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
