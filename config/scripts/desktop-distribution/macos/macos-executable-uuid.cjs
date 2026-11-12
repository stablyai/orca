// macOS Local Network privacy keys apps by main executable UUID; stock Electron's is shared by every app on that version (TN3179).
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

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

/** Rewrites LC_UUID in every slice in place; uuidFor(cpuType) returns the new 16 bytes. */
function rewriteMachOUuids(buffer, uuidFor) {
  const changes = []
  for (const offset of sliceOffsets(buffer)) {
    const magic = buffer.readUInt32LE(offset)
    if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) {
      throw new Error(
        `Unsupported Mach-O slice at offset ${offset} (magic 0x${magic.toString(16)})`
      )
    }
    const cpuType = buffer.readUInt32LE(offset + 4)
    const commandCount = buffer.readUInt32LE(offset + 16)
    let command = offset + (magic === MH_MAGIC_64 ? 32 : 28)
    let uuidOffset = -1
    for (let i = 0; i < commandCount; i++) {
      if (buffer.readUInt32LE(command) === LC_UUID) {
        uuidOffset = command + 8
        break
      }
      command += buffer.readUInt32LE(command + 4)
    }
    if (uuidOffset < 0) {
      throw new Error(`Mach-O slice for CPU type ${cpuType} has no LC_UUID`)
    }
    const before = formatUuid(buffer.subarray(uuidOffset, uuidOffset + 16))
    const next = uuidFor(cpuType)
    next.copy(buffer, uuidOffset)
    changes.push({ cpuType, before, after: formatUuid(next) })
  }
  return changes
}

function giveMacMainExecutableUniqueUuid(appPath, appId, executableName) {
  const executable = join(appPath, 'Contents', 'MacOS', executableName)
  const buffer = readFileSync(executable)
  const changes = rewriteMachOUuids(buffer, (cpuType) =>
    deriveExecutableUuid(appId, executableName, cpuType)
  )
  writeFileSync(executable, buffer)
  for (const { cpuType, before, after } of changes) {
    console.log(`[macos-executable-uuid] ${executableName} cpu ${cpuType}: ${before} -> ${after}`)
  }
}

module.exports = { giveMacMainExecutableUniqueUuid, rewriteMachOUuids }
