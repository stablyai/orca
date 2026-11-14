// macOS Local Network privacy maps a process to its app by executable UUID; stock Electron's is shared by every app shipping that build (TN3179).
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join } = require('node:path')

const MH_MAGIC = 0xfeedface
const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const LC_UUID = 0x1b

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString('hex').toUpperCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Stable per app, executable and CPU so releases keep one identity, as the stock UUID did within an Electron version.
function deriveExecutableUuid(appId, executableName, cpuType) {
  const uuid = createHash('sha256')
    .update(`${appId}\0${executableName}\0${cpuType}`)
    .digest()
    .subarray(0, 16)
  uuid[6] = (uuid[6] & 0x0f) | 0x80
  uuid[8] = (uuid[8] & 0x3f) | 0x80
  return uuid
}

function sliceOffsets(buffer) {
  const magic = buffer.readUInt32BE(0)
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    return [0]
  }
  const is64 = magic === FAT_MAGIC_64
  const count = buffer.readUInt32BE(4)
  const offsets = []
  for (let i = 0; i < count; i++) {
    const entry = 8 + i * (is64 ? 32 : 20)
    offsets.push(is64 ? Number(buffer.readBigUInt64BE(entry + 8)) : buffer.readUInt32BE(entry + 8))
  }
  return offsets
}

/** Where each slice's LC_UUID payload sits. */
function machOUuidSlots(buffer) {
  return sliceOffsets(buffer).map((offset) => {
    const magic = buffer.readUInt32LE(offset)
    if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) {
      throw new Error(
        `Unsupported Mach-O slice at offset ${offset} (magic 0x${magic.toString(16)})`
      )
    }
    const cpuType = buffer.readUInt32LE(offset + 4)
    const commandCount = buffer.readUInt32LE(offset + 16)
    let command = offset + (magic === MH_MAGIC_64 ? 32 : 28)
    for (let i = 0; i < commandCount; i++) {
      if (buffer.readUInt32LE(command) === LC_UUID) {
        return { cpuType, uuidOffset: command + 8 }
      }
      command += buffer.readUInt32LE(command + 4)
    }
    throw new Error(`Mach-O slice for CPU type ${cpuType} has no LC_UUID`)
  })
}

/** Rewrites LC_UUID in every slice of `buffer` in place. */
function rewriteMachOUuids(buffer, appId, executableName) {
  return machOUuidSlots(buffer).map(({ cpuType, uuidOffset }) => {
    const before = formatUuid(buffer.subarray(uuidOffset, uuidOffset + 16))
    const next = deriveExecutableUuid(appId, executableName, cpuType)
    next.copy(buffer, uuidOffset)
    return { cpuType, before, after: formatUuid(next) }
  })
}

/**
 * Gives the executable the UUID derived from `uuidName` (its own name by default), then re-signs it
 * ad hoc; real signing replaces that later.
 */
function giveMacExecutableUniqueUuid(executable, appId, uuidName = basename(executable)) {
  const name = basename(executable)
  const buffer = readFileSync(executable)
  const changes = rewriteMachOUuids(buffer, appId, uuidName)
  // The edit breaks Electron's linker ad hoc signature and arm64 kills unsigned code, but identity-less builds skip app signing.
  // Signed outside the bundle: in place, codesign would treat it as the bundle and require its unsigned siblings be signed.
  const staging = mkdtempSync(join(tmpdir(), 'orca-executable-uuid-'))
  try {
    const staged = join(staging, name)
    writeFileSync(staged, buffer, { mode: 0o755 })
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', appId, staged], {
      stdio: 'inherit'
    })
    copyFileSync(staged, executable)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  for (const { cpuType, before, after } of changes) {
    console.log(`[macos-executable-uuid] ${name} cpu ${cpuType}: ${before} -> ${after}`)
  }
}

/** Fails when a shipped executable lost its own UUID, e.g. the hook was skipped or signing rewrote it. */
function assertMacExecutableUuid(executable, appId, uuidName = basename(executable)) {
  const buffer = readFileSync(executable)
  for (const { cpuType, uuidOffset } of machOUuidSlots(buffer)) {
    const actual = formatUuid(buffer.subarray(uuidOffset, uuidOffset + 16))
    const expected = formatUuid(deriveExecutableUuid(appId, uuidName, cpuType))
    if (actual !== expected) {
      throw new Error(
        `[macos-executable-uuid] ${executable} cpu ${cpuType} has UUID ${actual}, expected ${expected}`
      )
    }
  }
}

module.exports = { assertMacExecutableUuid, giveMacExecutableUniqueUuid, rewriteMachOUuids }
