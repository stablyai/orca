import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  diagnoseWindowsPeMismatch,
  parseWindowsPeDiagnosticArguments
} from './ssh-relay-runtime-windows-pe-diagnostic.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

function peFixture({ identifierByte = 0x11, timestamp = 0x12345678 } = {}) {
  const bytes = Buffer.alloc(0x400)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.writeUInt32LE(0x00004550, 0x80)
  const coff = 0x84
  bytes.writeUInt16LE(0xaa64, coff)
  bytes.writeUInt16LE(1, coff + 2)
  bytes.writeUInt32LE(timestamp, coff + 4)
  bytes.writeUInt16LE(0xf0, coff + 16)
  bytes.writeUInt16LE(0x2022, coff + 18)
  const optional = coff + 20
  bytes.writeUInt16LE(0x20b, optional)
  bytes[optional + 2] = 14
  bytes.writeUInt32LE(0x100, optional + 4)
  bytes.writeUInt32LE(0x100, optional + 8)
  bytes.writeUInt32LE(0x2000, optional + 16)
  bytes.writeBigUInt64LE(0x180000000n, optional + 24)
  bytes.writeUInt32LE(0x1000, optional + 32)
  bytes.writeUInt32LE(0x200, optional + 36)
  bytes.writeUInt32LE(0x3000, optional + 56)
  bytes.writeUInt32LE(0x200, optional + 60)
  bytes.writeUInt16LE(3, optional + 68)
  bytes.writeUInt16LE(0x160, optional + 70)
  bytes.writeUInt32LE(16, optional + 108)
  const debugDataDirectory = optional + 112 + 6 * 8
  bytes.writeUInt32LE(0x2000, debugDataDirectory)
  bytes.writeUInt32LE(28, debugDataDirectory + 4)
  const section = optional + 0xf0
  bytes.write('.rdata', section, 'ascii')
  bytes.writeUInt32LE(0x200, section + 8)
  bytes.writeUInt32LE(0x2000, section + 12)
  bytes.writeUInt32LE(0x200, section + 16)
  bytes.writeUInt32LE(0x200, section + 20)
  bytes.writeUInt32LE(0x40000040, section + 36)
  const debug = 0x200
  bytes.writeUInt32LE(timestamp, debug + 4)
  bytes.writeUInt32LE(2, debug + 12)
  bytes.writeUInt32LE(32, debug + 16)
  bytes.writeUInt32LE(0x2020, debug + 20)
  bytes.writeUInt32LE(0x220, debug + 24)
  bytes.write('RSDS', 0x220, 'ascii')
  bytes.fill(identifierByte, 0x224, 0x234)
  bytes.writeUInt32LE(1, 0x234)
  bytes.write('test.pdb\0', 0x238, 'ascii')
  return bytes
}

async function fixturePair(firstBytes, secondBytes) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-windows-pe-diagnostic-'))
  temporaryDirectories.push(directory)
  const firstPePath = join(directory, 'first.node')
  const secondPePath = join(directory, 'second.node')
  await Promise.all([writeFile(firstPePath, firstBytes), writeFile(secondPePath, secondBytes)])
  return { firstPePath, secondPePath }
}

describe('SSH relay Windows PE mismatch diagnostic', () => {
  it('reports bounded byte ranges and relevant header differences without file paths', async () => {
    const first = peFixture()
    const second = peFixture({ identifierByte: 0x22, timestamp: 0x87654321 })
    second[0x300] = 0xff
    const fixture = await fixturePair(first, second)

    const result = await diagnoseWindowsPeMismatch(fixture)

    expect(result).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        first: expect.objectContaining({ bytes: 0x400, sha256: expect.stringMatching(/^sha256:/) }),
        second: expect.objectContaining({
          bytes: 0x400,
          sha256: expect.stringMatching(/^sha256:/)
        }),
        difference: expect.objectContaining({
          differingBytes: 25,
          rangeCount: 4,
          rangesTruncated: false
        })
      })
    )
    expect(result.first.pe.coff.machine).toBe('0xaa64')
    expect(result.first.pe.sections[0].name).toBe('.rdata')
    expect(result.difference.ranges.map((range) => range.firstRegion)).toEqual([
      'COFF header',
      'debug directory',
      'CodeView data 0',
      'section .rdata'
    ])
    expect(result.difference.regionSummaries).toEqual([
      expect.objectContaining({ firstRegion: 'COFF header', differingBytes: 4, rangeCount: 1 }),
      expect.objectContaining({ firstRegion: 'debug directory', differingBytes: 4, rangeCount: 1 }),
      expect.objectContaining({
        firstRegion: 'CodeView data 0',
        differingBytes: 16,
        rangeCount: 1
      }),
      expect.objectContaining({ firstRegion: 'section .rdata', differingBytes: 1, rangeCount: 1 })
    ])
    expect(result.difference.regionSummaries[3].samples[0]).toEqual(
      expect.objectContaining({ firstBytes: '00', secondBytes: 'ff', bytesTruncated: false })
    )
    expect(result.difference.headerDifferences.map((entry) => entry.field)).toEqual([
      'coff.timeDateStamp',
      'debugDirectory.0.codeView.identifier',
      'debugDirectory.0.timeDateStamp'
    ])
    expect(JSON.stringify(result)).not.toContain(fixture.firstPePath)
  })

  it('rejects oversized, invalid, same-file, and aborted diagnostics', async () => {
    const fixture = await fixturePair(peFixture(), peFixture())
    await expect(
      diagnoseWindowsPeMismatch({
        firstPePath: fixture.firstPePath,
        secondPePath: fixture.firstPePath
      })
    ).rejects.toThrow('must be distinct')
    await writeFile(fixture.secondPePath, 'not a PE')
    await expect(diagnoseWindowsPeMismatch(fixture)).rejects.toThrow('bounded header')

    const handle = await open(fixture.secondPePath, 'w')
    await handle.truncate(64 * 1024 * 1024 + 1)
    await handle.close()
    await expect(diagnoseWindowsPeMismatch(fixture)).rejects.toThrow('size limit')
    await expect(
      diagnoseWindowsPeMismatch({ ...fixture, signal: AbortSignal.abort() })
    ).rejects.toThrow('aborted')
  })

  it('caps per-region samples and per-range byte excerpts', async () => {
    const first = peFixture()
    const second = peFixture()
    for (let index = 0; index < 10; index += 1) {
      second[0x280 + index * 2] = 0xff
    }
    second.fill(0xff, 0x340, 0x368)
    const result = await diagnoseWindowsPeMismatch(await fixturePair(first, second))

    expect(result.difference.regionSummaries).toEqual([
      expect.objectContaining({
        firstRegion: 'section .rdata',
        differingBytes: 50,
        rangeCount: 11,
        samples: expect.any(Array)
      })
    ])
    expect(result.difference.regionSummaries[0].samples).toHaveLength(8)
    expect(result.difference.ranges.at(-1)).toEqual(
      expect.objectContaining({
        length: 40,
        bytesTruncated: true,
        firstBytes: '00'.repeat(32),
        secondBytes: 'ff'.repeat(32)
      })
    )
  })

  it('parses only the two explicit CLI inputs', () => {
    expect(
      parseWindowsPeDiagnosticArguments(['--first-pe', 'first.node', '--second-pe', 'second.node'])
    ).toEqual({ firstPePath: 'first.node', secondPePath: 'second.node' })
    expect(() => parseWindowsPeDiagnosticArguments(['--other', 'value'])).toThrow(
      'Unknown argument'
    )
  })
})
