import { describe, expect, it } from 'vitest'
import { parseDarwinUnusedBytes } from './zotz-darwin-memory-signals'

// A 24 GB Mac with 10 GB in swap, where the kernel reported 64% free (15.4 GB).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   160394.
Pages active:                                 407179.
Pages inactive:                               355116.
Pages speculative:                             51988.
Pages wired down:                             235609.
Pages purgeable:                               11601.
File-backed pages:                            272050.
Anonymous pages:                              542233.
Pages stored in compressor:                  1613313.
Pages occupied by compressor:                 300228.
`

describe('parseDarwinUnusedBytes', () => {
  it('leaves out app, wired and compressed memory like Activity Monitor', () => {
    expect(parseDarwinUnusedBytes(VM_STAT, 25_769_803_776)).toBe(8_296_775_680)
  })

  it('gives up when a field is missing', () => {
    expect(
      parseDarwinUnusedBytes(VM_STAT.replace(/^Anonymous pages.*$/m, ''), 25_769_803_776)
    ).toBeNull()
  })
})
