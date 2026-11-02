import { open, type FileHandle } from 'node:fs/promises'
import { createStatStyleNamer, parseFontVariationInstances } from './sfnt-variation-instances'

const COLLECTION_TAG = 0x74746366 // 'ttcf'
const NAME_TABLE_TAG = 0x6e616d65 // 'name'
const FONT_VARIATIONS_TABLE_TAG = 0x66766172 // 'fvar'
const STYLE_ATTRIBUTES_TABLE_TAG = 0x53544154 // 'STAT'
const FAMILY_NAME_ID = 1
const TYPOGRAPHIC_FAMILY_NAME_ID = 16
// GDI keeps these styles inside the base family rather than naming a family after them.
const RIBBI_STYLE_WORDS = new Set(['regular', 'bold', 'italic'])
const MAC_PLATFORM_ID = 1
const WINDOWS_PLATFORM_ID = 3
const MAC_ENGLISH_LANGUAGE_ID = 0
const WINDOWS_ENGLISH_US_LANGUAGE_ID = 0x0409
// Bounds past these are corrupt files; never allocate what a bad header claims.
const MAX_COLLECTION_FONTS = 64
const MAX_TABLE_COUNT = 1024
const MAX_NAME_TABLE_BYTES = 1024 * 1024
const MAX_VARIATION_TABLE_BYTES = 256 * 1024

const utf16BigEndian = new TextDecoder('utf-16be')

/**
 * The family names GDI lists for a TrueType/OpenType font or collection: the legacy family plus one
 * per variable-font named instance. Reads only the table directory and the name/fvar tables.
 */
export async function readSfntFamilyNames(path: string): Promise<string[]> {
  const file = await open(path, 'r')
  try {
    const header = await readBytes(file, 0, 12)
    const fontOffsets =
      header.readUInt32BE(0) === COLLECTION_TAG ? await readCollectionOffsets(file, header) : [0]
    const names = new Set<string>()
    for (const fontOffset of fontOffsets) {
      for (const name of await readFontFamilyNames(file, fontOffset)) {
        names.add(name)
      }
    }
    return [...names]
  } finally {
    await file.close()
  }
}

type SfntTable = { offset: number; length: number }

/** Name strings by ID, preferring English Windows records. */
function parseNameTable(table: Buffer, nameIds: ReadonlySet<number>): Map<number, string> {
  const best = new Map<number, { rank: number; value: string }>()
  if (table.length < 6) {
    return new Map()
  }
  const recordCount = table.readUInt16BE(2)
  const storageOffset = table.readUInt16BE(4)
  for (let index = 0; index < recordCount; index++) {
    const record = 6 + index * 12
    if (record + 12 > table.length) {
      break
    }
    const platformId = table.readUInt16BE(record)
    const nameId = table.readUInt16BE(record + 6)
    const rank = nameRecordRank(platformId, table.readUInt16BE(record + 4))
    const current = best.get(nameId)
    if (!nameIds.has(nameId) || rank === null || (current && current.rank <= rank)) {
      continue
    }
    const start = storageOffset + table.readUInt16BE(record + 10)
    const end = start + table.readUInt16BE(record + 8)
    if (end > table.length) {
      continue
    }
    const bytes = table.subarray(start, end)
    const value = (
      platformId === WINDOWS_PLATFORM_ID ? utf16BigEndian.decode(bytes) : bytes.toString('latin1')
    ).trim()
    if (value) {
      best.set(nameId, { rank, value })
    }
  }
  return new Map([...best].map(([nameId, entry]) => [nameId, entry.value]))
}

function namedInstanceFamily(family: string, styleNames: string[]): string {
  const styleWords = styleNames
    .flatMap((styleName) => styleName.split(/\s+/))
    .filter((word) => !RIBBI_STYLE_WORDS.has(word.toLowerCase()))
  return [family, ...styleWords].join(' ')
}

// English Windows records are what Chromium matches; Mac Roman records only cover legacy fonts.
function nameRecordRank(platformId: number, languageId: number): number | null {
  if (platformId === WINDOWS_PLATFORM_ID) {
    return languageId === WINDOWS_ENGLISH_US_LANGUAGE_ID ? 0 : 1
  }
  if (platformId === MAC_PLATFORM_ID && languageId === MAC_ENGLISH_LANGUAGE_ID) {
    return 2
  }
  return null
}

async function readCollectionOffsets(file: FileHandle, header: Buffer): Promise<number[]> {
  const fontCount = header.readUInt32BE(8)
  if (fontCount === 0 || fontCount > MAX_COLLECTION_FONTS) {
    throw new Error(`Invalid font collection size ${fontCount}`)
  }
  const offsets = await readBytes(file, 12, fontCount * 4)
  return Array.from({ length: fontCount }, (_, index) => offsets.readUInt32BE(index * 4))
}

async function readFontFamilyNames(file: FileHandle, fontOffset: number): Promise<string[]> {
  const tables = await readTableDirectory(file, fontOffset)
  const nameTable = tables.get(NAME_TABLE_TAG)
  if (!nameTable || nameTable.length > MAX_NAME_TABLE_BYTES) {
    return []
  }
  const fvar = await readVariationTable(file, tables.get(FONT_VARIATIONS_TABLE_TAG))
  const instances = fvar ? parseFontVariationInstances(fvar) : []
  const statStyleNameIds = createStatStyleNamer(
    instances.length > 0
      ? await readVariationTable(file, tables.get(STYLE_ATTRIBUTES_TABLE_TAG))
      : null
  )
  const instanceStyleNameIds = instances.map(
    (instance) => statStyleNameIds(instance) ?? [instance.subfamilyNameId]
  )
  const names = parseNameTable(
    await readTable(file, nameTable),
    new Set([FAMILY_NAME_ID, TYPOGRAPHIC_FAMILY_NAME_ID, ...instanceStyleNameIds.flat()])
  )
  const family = names.get(FAMILY_NAME_ID)
  if (!family) {
    return []
  }
  if (instances.length === 0) {
    return [family]
  }
  // Windows lists only the named instances of a variable font, built on its typographic family.
  const instanceBase = names.get(TYPOGRAPHIC_FAMILY_NAME_ID) ?? family
  return instanceStyleNameIds.map((nameIds) =>
    namedInstanceFamily(
      instanceBase,
      nameIds.flatMap((nameId) => names.get(nameId) ?? [])
    )
  )
}

async function readVariationTable(
  file: FileHandle,
  table: SfntTable | undefined
): Promise<Buffer | null> {
  return table && table.length <= MAX_VARIATION_TABLE_BYTES ? readTable(file, table) : null
}

async function readTableDirectory(
  file: FileHandle,
  fontOffset: number
): Promise<Map<number, SfntTable>> {
  const header = await readBytes(file, fontOffset, 12)
  const tableCount = header.readUInt16BE(4)
  if (tableCount > MAX_TABLE_COUNT) {
    throw new Error(`Invalid font table count ${tableCount}`)
  }
  const records = await readBytes(file, fontOffset + 12, tableCount * 16)
  const tables = new Map<number, SfntTable>()
  for (let index = 0; index < tableCount; index++) {
    const record = index * 16
    tables.set(records.readUInt32BE(record), {
      offset: records.readUInt32BE(record + 8),
      length: records.readUInt32BE(record + 12)
    })
  }
  return tables
}

function readTable(file: FileHandle, table: SfntTable): Promise<Buffer> {
  return readBytes(file, table.offset, table.length)
}

async function readBytes(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, position)
  if (bytesRead < length) {
    throw new Error('Truncated font file')
  }
  return buffer
}
