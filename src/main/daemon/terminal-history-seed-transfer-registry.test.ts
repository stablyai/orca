import { describe, expect, it } from 'vitest'
import {
  iterateTerminalHistorySeedChunks,
  measureTerminalHistorySeed
} from './terminal-history-seed-chunks'
import { TerminalHistorySeedTransferRegistry } from './terminal-history-seed-transfer-registry'

describe('TerminalHistorySeedTransferRegistry', () => {
  it('validates and consumes an owner-bound completed transfer', () => {
    const registry = new TerminalHistorySeedTransferRegistry()
    const segments = ['first', '😀', 'last']
    const manifest = measureTerminalHistorySeed(segments)
    const transferId = registry.start('owner-a', manifest)
    const chunks = [...iterateTerminalHistorySeedChunks(segments)]
    chunks.forEach((data, index) => registry.append('owner-a', transferId, index, data))
    registry.finish('owner-a', transferId)

    expect(() => registry.take('owner-b', transferId)).toThrow('not found')
    expect(registry.take('owner-a', transferId).join('')).toBe(segments.join(''))
    expect(() => registry.take('owner-a', transferId)).toThrow('not found')
  })

  it('rejects out-of-order and over-budget chunks', () => {
    const segments = ['😀', 'a']
    const manifest = measureTerminalHistorySeed(segments)
    const registry = new TerminalHistorySeedTransferRegistry(4)
    const transferId = registry.start('owner', manifest)

    expect(() => registry.append('owner', transferId, 1, 'a')).toThrow('sequence mismatch')
    registry.append('owner', transferId, 0, '😀')
    expect(() => registry.append('owner', transferId, 1, 'a')).toThrow('retained byte limit')
  })

  it('rejects a digest mismatch and releases the transfer', () => {
    const registry = new TerminalHistorySeedTransferRegistry()
    const transferId = registry.start('owner', {
      chunkCount: 1,
      codeUnits: 4,
      sha256: '0'.repeat(64)
    })
    registry.append('owner', transferId, 0, 'test')

    expect(() => registry.finish('owner', transferId)).toThrow('digest mismatch')
    expect(() => registry.take('owner', transferId)).toThrow('not found')
  })
})
