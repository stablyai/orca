import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSfntFamilyNames } from './sfnt-family-names'

type NameRecord = { platformId: number; languageId: number; nameId: number; value: string }

function encodeName(record: NameRecord): Buffer {
  if (record.platformId !== 3) {
    return Buffer.from(record.value, 'latin1')
  }
  return Buffer.from(record.value, 'utf16le').swap16()
}

function nameTable(records: NameRecord[]): Buffer {
  const strings = records.map(encodeName)
  const header = Buffer.alloc(6 + records.length * 12)
  header.writeUInt16BE(records.length, 2)
  header.writeUInt16BE(header.length, 4)
  let stringOffset = 0
  records.forEach((record, index) => {
    const offset = 6 + index * 12
    header.writeUInt16BE(record.platformId, offset)
    header.writeUInt16BE(record.platformId === 3 ? 1 : 0, offset + 2)
    header.writeUInt16BE(record.languageId, offset + 4)
    header.writeUInt16BE(record.nameId, offset + 6)
    header.writeUInt16BE(strings[index].length, offset + 8)
    header.writeUInt16BE(stringOffset, offset + 10)
    stringOffset += strings[index].length
  })
  return Buffer.concat([header, ...strings])
}

type TestFont = { names: NameRecord[]; instanceNameIds?: number[] }

// One axis, no coordinates beyond what the parser skips; only subfamily name IDs matter here.
function fontVariationsTable(instanceNameIds: number[]): Buffer {
  const axisSize = 20
  const instanceSize = 4 + 4
  const table = Buffer.alloc(16 + axisSize + instanceNameIds.length * instanceSize)
  table.writeUInt16BE(1, 0)
  table.writeUInt16BE(16, 4)
  table.writeUInt16BE(1, 8)
  table.writeUInt16BE(axisSize, 10)
  table.writeUInt16BE(instanceNameIds.length, 12)
  table.writeUInt16BE(instanceSize, 14)
  instanceNameIds.forEach((nameId, index) => {
    table.writeUInt16BE(nameId, 16 + axisSize + index * instanceSize)
  })
  return table
}

// Lays out a 'ttcf' collection whose fonts hold only name (and optional fvar) tables.
function fontCollection(fonts: TestFont[]): Buffer {
  const fontTables = fonts.map((font) => {
    const tables: [string, Buffer][] = [['name', nameTable(font.names)]]
    if (font.instanceNameIds) {
      tables.push(['fvar', fontVariationsTable(font.instanceNameIds)])
    }
    return tables
  })
  const collectionHeaderLength = 12 + fonts.length * 4
  const fontHeaderLengths = fontTables.map((tables) => 12 + tables.length * 16)
  const collectionHeader = Buffer.alloc(collectionHeaderLength)
  collectionHeader.write('ttcf', 0, 'latin1')
  collectionHeader.writeUInt32BE(fonts.length, 8)
  const fontHeaders: Buffer[] = []
  let fontOffset = collectionHeaderLength
  let tableOffset =
    collectionHeaderLength + fontHeaderLengths.reduce((sum, length) => sum + length, 0)
  fontTables.forEach((tables, fontIndex) => {
    collectionHeader.writeUInt32BE(fontOffset, 12 + fontIndex * 4)
    fontOffset += fontHeaderLengths[fontIndex]
    const fontHeader = Buffer.alloc(fontHeaderLengths[fontIndex])
    fontHeader.writeUInt32BE(0x00010000, 0)
    fontHeader.writeUInt16BE(tables.length, 4)
    tables.forEach(([tag, table], tableIndex) => {
      const record = 12 + tableIndex * 16
      fontHeader.write(tag, record, 'latin1')
      fontHeader.writeUInt32BE(tableOffset, record + 8)
      fontHeader.writeUInt32BE(table.length, record + 12)
      tableOffset += table.length
    })
    fontHeaders.push(fontHeader)
  })
  return Buffer.concat([
    collectionHeader,
    ...fontHeaders,
    ...fontTables.flat().map(([, table]) => table)
  ])
}

describe('readSfntFamilyNames', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-sfnt-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('lists the English legacy family and every named instance family in a collection', async () => {
    const file = join(directory, 'msgothic.ttc')
    await writeFile(
      file,
      fontCollection([
        {
          names: [
            { platformId: 1, languageId: 0, nameId: 1, value: 'Mac Legacy' },
            { platformId: 3, languageId: 0x0411, nameId: 1, value: 'ＭＳ ゴシック' },
            { platformId: 3, languageId: 0x0409, nameId: 1, value: 'MS Gothic' },
            { platformId: 3, languageId: 0x0409, nameId: 2, value: 'Regular' }
          ]
        },
        {
          names: [
            { platformId: 3, languageId: 0x0409, nameId: 1, value: 'Segoe UI Semibold' },
            { platformId: 3, languageId: 0x0409, nameId: 16, value: 'Segoe UI' }
          ]
        },
        {
          names: [
            { platformId: 3, languageId: 0x0409, nameId: 1, value: 'Bahnschrift' },
            { platformId: 3, languageId: 0x0409, nameId: 256, value: 'Regular' },
            { platformId: 3, languageId: 0x0409, nameId: 257, value: 'SemiBold Condensed' },
            { platformId: 3, languageId: 0x0409, nameId: 258, value: 'Bold Italic' }
          ],
          instanceNameIds: [256, 257, 258]
        }
      ])
    )

    await expect(readSfntFamilyNames(file)).resolves.toEqual([
      'MS Gothic',
      'Segoe UI Semibold',
      'Bahnschrift',
      'Bahnschrift SemiBold Condensed'
    ])
  })

  it('rejects a truncated font file', async () => {
    const file = join(directory, 'broken.ttf')
    await writeFile(file, fontCollection([{ names: [] }]).subarray(0, 20))

    await expect(readSfntFamilyNames(file)).rejects.toThrow('Truncated font file')
  })
})
