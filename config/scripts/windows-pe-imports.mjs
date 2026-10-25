// Why a hand-rolled reader: the release guard only needs the import table's DLL
// names, and a parser dependency would be a new supply-chain input for one check.
const IMPORT_DIRECTORY_INDEX = 1

export function readPeImportedDllNames(buffer) {
  const peOffset = buffer.readUInt32LE(0x3c)
  if (buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('Not a PE image')
  }
  const sectionCount = buffer.readUInt16LE(peOffset + 6)
  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20)
  const optionalHeader = peOffset + 24
  const isPe32Plus = buffer.readUInt16LE(optionalHeader) === 0x20b
  const dataDirectories = optionalHeader + (isPe32Plus ? 112 : 96)
  const importRva = buffer.readUInt32LE(dataDirectories + IMPORT_DIRECTORY_INDEX * 8)
  if (importRva === 0) {
    return []
  }
  const sections = []
  for (let index = 0; index < sectionCount; index += 1) {
    const header = optionalHeader + optionalHeaderSize + index * 40
    sections.push({
      virtualAddress: buffer.readUInt32LE(header + 12),
      size: Math.max(buffer.readUInt32LE(header + 8), buffer.readUInt32LE(header + 16)),
      rawOffset: buffer.readUInt32LE(header + 20)
    })
  }
  const fileOffset = (rva) => {
    const section = sections.find(
      (candidate) =>
        rva >= candidate.virtualAddress && rva < candidate.virtualAddress + candidate.size
    )
    if (!section) {
      throw new Error(`RVA 0x${rva.toString(16)} is outside every section`)
    }
    return rva - section.virtualAddress + section.rawOffset
  }
  const names = []
  for (let descriptor = fileOffset(importRva); ; descriptor += 20) {
    const nameRva = buffer.readUInt32LE(descriptor + 12)
    if (nameRva === 0) {
      return names
    }
    const start = fileOffset(nameRva)
    names.push(buffer.toString('latin1', start, buffer.indexOf(0, start)))
  }
}

// The Visual C++ runtime DLLs ship with the Redistributable, not with Windows.
const DYNAMIC_VC_RUNTIME_RE = /^(?:vcruntime|msvcp|msvcr)\d+(?:_\d+)?\.dll$/i

export function findDynamicVcRuntimeImports(dllNames) {
  return dllNames.filter((name) => DYNAMIC_VC_RUNTIME_RE.test(name))
}
