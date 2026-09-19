import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const ELF_MACHINE = { 0x3e: 'x64', 0xb7: 'arm64' }
const MACH_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64' }
export const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }
const PE_ARCH = Object.fromEntries(Object.entries(PE_MACHINE).map(([arch, value]) => [value, arch]))

export function inspectNativeExecutable(binaryPath) {
  const fd = openSync(binaryPath, 'r')
  try {
    const size = fstatSync(fd).size
    const header = readExact(fd, Math.min(64, size), 0, binaryPath)
    if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      return inspectElf(fd, header, size, binaryPath)
    }
    if (header.length >= 4 && header.readUInt32LE(0) === 0xfeedfacf) {
      if (header.length < 8) {
        throw new Error(`${binaryPath} has a truncated Mach-O header`)
      }
      const cpu = header.readUInt32LE(4)
      const arch = MACH_CPU[cpu]
      if (!arch) {
        throw new Error(`${binaryPath} has unsupported Mach-O CPU 0x${cpu.toString(16)}`)
      }
      return { format: 'macho', arch, machine: cpu, interpreter: null }
    }
    if (header.length >= 2 && header.subarray(0, 2).toString('ascii') === 'MZ') {
      return inspectPe(fd, header, size, binaryPath)
    }
    throw new Error(`${binaryPath} is not a supported ELF, Mach-O, or PE executable`)
  } finally {
    closeSync(fd)
  }
}

export function readPeMachine(binaryPath) {
  const identity = inspectNativeExecutable(binaryPath)
  if (identity.format !== 'pe') {
    throw new Error(`${binaryPath} is ${identity.format}, not PE`)
  }
  return identity.machine
}

function inspectElf(fd, header, size, binaryPath) {
  if (header.length < 64 || header[4] !== 2 || header[5] !== 1) {
    throw new Error(`${binaryPath} must be a little-endian ELF64 binary`)
  }
  const machine = header.readUInt16LE(18)
  const arch = ELF_MACHINE[machine]
  if (!arch) {
    throw new Error(`${binaryPath} has unsupported ELF machine 0x${machine.toString(16)}`)
  }
  const programHeaderOffset = safeOffset(header.readBigUInt64LE(32), binaryPath)
  const entrySize = header.readUInt16LE(54)
  const entryCount = header.readUInt16LE(56)
  if (entryCount > 1_024 || (entryCount > 0 && entrySize < 56)) {
    throw new Error(`${binaryPath} has an invalid ELF program-header table`)
  }
  let interpreter = null
  for (let index = 0; index < entryCount; index++) {
    const offset = programHeaderOffset + index * entrySize
    if (!Number.isSafeInteger(offset) || offset > size - 56) {
      throw new Error(`${binaryPath} has an out-of-bounds ELF program header`)
    }
    const programHeader = readExact(fd, 56, offset, binaryPath)
    if (programHeader.readUInt32LE(0) !== 3) {
      continue
    }
    const interpreterOffset = safeOffset(programHeader.readBigUInt64LE(8), binaryPath)
    const interpreterBytes = safeOffset(programHeader.readBigUInt64LE(32), binaryPath)
    if (
      interpreterBytes < 2 ||
      interpreterBytes > 4_096 ||
      interpreterOffset > size - interpreterBytes
    ) {
      throw new Error(`${binaryPath} has an invalid ELF interpreter record`)
    }
    const interpreterRecord = readExact(fd, interpreterBytes, interpreterOffset, binaryPath)
    if (interpreterRecord.at(-1) !== 0) {
      throw new Error(`${binaryPath} has an unterminated ELF interpreter record`)
    }
    interpreter = interpreterRecord.subarray(0, -1).toString('utf8')
    break
  }
  return { format: 'elf', arch, machine, interpreter }
}

function inspectPe(fd, header, size, binaryPath) {
  if (header.length < 64) {
    throw new Error(`${binaryPath} has a truncated DOS header`)
  }
  const peOffset = header.readUInt32LE(0x3c)
  if (peOffset > size - 6) {
    throw new Error(`${binaryPath} has an out-of-bounds PE header`)
  }
  const peHeader = readExact(fd, 6, peOffset, binaryPath)
  if (!peHeader.subarray(0, 4).equals(Buffer.from('PE\0\0', 'binary'))) {
    throw new Error(`${binaryPath} has an invalid PE signature`)
  }
  const machine = peHeader.readUInt16LE(4)
  const arch = PE_ARCH[machine]
  if (!arch) {
    throw new Error(`${binaryPath} has unsupported PE machine 0x${machine.toString(16)}`)
  }
  return { format: 'pe', arch, machine, interpreter: null }
}

function safeOffset(value, binaryPath) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${binaryPath} contains an unsafe binary offset`)
  }
  return Number(value)
}

function readExact(fd, length, position, binaryPath) {
  const bytes = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const read = readSync(fd, bytes, total, length - total, position + total)
    if (read === 0) {
      throw new Error(`${binaryPath} ended while reading its native executable headers`)
    }
    total += read
  }
  return bytes
}
