import { describe, expect, it } from 'vitest'
import { findDynamicVcRuntimeImports, readPeImportedDllNames } from './windows-pe-imports.mjs'

// Smallest PE32+ image with one section holding an import directory for `dllNames`.
function peWithImports(dllNames) {
  const peOffset = 0x40
  const optionalHeaderSize = 240
  const sectionHeader = peOffset + 24 + optionalHeaderSize
  const rawOffset = 0x200
  const virtualAddress = 0x1000
  const descriptorsSize = (dllNames.length + 1) * 20
  const strings = dllNames.map((name) => Buffer.from(`${name}\0`, 'latin1'))
  const sectionSize = descriptorsSize + strings.reduce((sum, item) => sum + item.length, 0)
  const buffer = Buffer.alloc(rawOffset + sectionSize)
  buffer.write('MZ', 0, 'latin1')
  buffer.writeUInt32LE(peOffset, 0x3c)
  buffer.write('PE\0\0', peOffset, 'latin1')
  buffer.writeUInt16LE(0x8664, peOffset + 4)
  buffer.writeUInt16LE(1, peOffset + 6)
  buffer.writeUInt16LE(optionalHeaderSize, peOffset + 20)
  buffer.writeUInt16LE(0x20b, peOffset + 24)
  buffer.writeUInt32LE(virtualAddress, peOffset + 24 + 112 + 8)
  buffer.writeUInt32LE(sectionSize, sectionHeader + 8)
  buffer.writeUInt32LE(virtualAddress, sectionHeader + 12)
  buffer.writeUInt32LE(sectionSize, sectionHeader + 16)
  buffer.writeUInt32LE(rawOffset, sectionHeader + 20)
  let stringRva = virtualAddress + descriptorsSize
  strings.forEach((item, index) => {
    buffer.writeUInt32LE(stringRva, rawOffset + index * 20 + 12)
    item.copy(buffer, rawOffset + (stringRva - virtualAddress))
    stringRva += item.length
  })
  return buffer
}

describe('windows PE imports', () => {
  it('reads every imported DLL name in order', () => {
    const names = ['KERNEL32.dll', 'VCRUNTIME140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']
    expect(readPeImportedDllNames(peWithImports(names))).toEqual(names)
  })

  it('reads an image with no imports', () => {
    expect(readPeImportedDllNames(peWithImports([]))).toEqual([])
  })

  it('rejects a file that is not a PE image', () => {
    const buffer = Buffer.alloc(0x80)
    buffer.writeUInt32LE(0x40, 0x3c)
    expect(() => readPeImportedDllNames(buffer)).toThrow('Not a PE image')
  })

  it('flags only the Visual C++ Redistributable DLLs', () => {
    expect(
      findDynamicVcRuntimeImports([
        'KERNEL32.dll',
        'ntdll.dll',
        'VCRUNTIME140.dll',
        'vcruntime140_1.dll',
        'MSVCP140.dll',
        'msvcr120.dll',
        'api-ms-win-crt-heap-l1-1-0.dll',
        'ucrtbase.dll'
      ])
    ).toEqual(['VCRUNTIME140.dll', 'vcruntime140_1.dll', 'MSVCP140.dll', 'msvcr120.dll'])
  })
})
