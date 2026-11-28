import { constants, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { FlexAssembler, arrayRule, objectRule } from 'stream-json/core/utils/flex-assembler.js'
import { createJsonTokenReader } from '../../../../shared/json-stream/json-token-reader'
import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { AgentSessionJournalError } from '../writing/journal-write-guards'
import {
  assertJournalLegacyRecordFilesStable,
  changedRecordFile,
  recordFileIdentity,
  type RecordFile
} from './journal-legacy-record-identity'
import { validateLegacyAgentSessionTabs } from './journal-legacy-record-tabs'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreRecord,
  isReadableRetiredAgentSessionClaimKey
} from '../../../runtime/agent-session/records/agent-session-store-row-rules'

type Generation = 'primary' | 'backup'
const CHUNK_BYTES = 64 * 1024
const OBJECT_SECTIONS = ['records', 'operations', 'unusableRecords'] as const
const ARRAY_SECTIONS = ['retiredClaimKeys', 'sessionTabs', 'visibleSessionIds'] as const
type Section = (typeof OBJECT_SECTIONS)[number] | (typeof ARRAY_SECTIONS)[number]

type StagedGeneration = {
  generation: Generation
  hostId: string
  tabs: 'sessionTabs' | 'visibleSessionIds' | null
}

export type JournalLegacyRecordSnapshot = (StagedGeneration & { salvage: boolean }) | null

export function createJournalLegacyRecordStage(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = FILE')
  db.exec(`
    CREATE TABLE legacy_rows (
      generation TEXT NOT NULL,
      section TEXT NOT NULL,
      key TEXT NOT NULL,
      body TEXT NOT NULL,
      readable INTEGER NOT NULL,
      PRIMARY KEY (generation, section, key)
    );
  `)
}

/** Reads only the opened file's initial extent and rechecks the handle and name before fallback. */
async function readStableRecordFile(
  file: RecordFile,
  consume: (bytes: Buffer) => void,
  checkCancellation: () => void
): Promise<void> {
  checkCancellation()
  if (!statSync(file.path).isFile()) {
    throw new Error('expected a regular original chat records file')
  }
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
  const handle = await open(file.path, flags)
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || recordFileIdentity(stats) !== file.identity) {
      throw changedRecordFile()
    }
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    let offset = 0n
    while (offset < stats.size) {
      checkCancellation()
      const remaining = stats.size - offset
      const length = remaining < CHUNK_BYTES ? Number(remaining) : CHUNK_BYTES
      const { bytesRead } = await handle.read(buffer, 0, length, null)
      checkCancellation()
      if (bytesRead === 0) {
        throw changedRecordFile()
      }
      offset += BigInt(bytesRead)
      consume(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat({ bigint: true })
    if (recordFileIdentity(after) !== file.identity) {
      throw changedRecordFile()
    }
    assertJournalLegacyRecordFilesStable([file])
  } finally {
    await handle.close()
  }
}

function isQuarantinedRecord(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    value.reason.length > 0
  )
}

function isReadableSectionEntry(section: Section, key: string, value: unknown): boolean {
  switch (section) {
    case 'records':
      return isReadableAgentSessionStoreRecord(key, value)
    case 'operations':
      return isReadableAgentSessionStoreOperation(key, value)
    case 'unusableRecords':
      return isQuarantinedRecord(value)
    case 'retiredClaimKeys':
      return isReadableRetiredAgentSessionClaimKey(value)
    default:
      return true
  }
}

type StageWrite = { section: Section; entry?: { key: string; body: string; readable: boolean } }

async function stageRecordFile(
  db: Database.Database,
  file: RecordFile,
  generation: Generation,
  checkCancellation: () => void
): Promise<StagedGeneration | null> {
  const pending: StageWrite[] = []
  const envelope = new Map<string, unknown>()
  const stagedSection = Symbol('staged section')
  let activeSection: Section | undefined
  let arrayIndex = 0
  let malformed = false
  const clear = db.prepare('DELETE FROM legacy_rows WHERE generation=? AND section=?')
  const insert = db.prepare(`INSERT INTO legacy_rows VALUES(?,?,?,?,?)
    ON CONFLICT(generation,section,key) DO UPDATE SET body=excluded.body,readable=excluded.readable`)
  const begin = (section: Section): null => {
    activeSection = section
    pending.push({ section })
    arrayIndex = 0
    return null
  }
  const end = (): typeof stagedSection => {
    activeSection = undefined
    return stagedSection
  }
  const add = (section: Section, key: string, value: unknown): void => {
    pending.push({
      section,
      entry: {
        key,
        body: JSON.stringify(value),
        readable: isReadableSectionEntry(section, key, value)
      }
    })
  }
  const discard = { filter: () => activeSection === undefined, create: () => null, add: () => {} }
  const assembler = new FlexAssembler({
    maxDepth: Infinity,
    objectRules: [
      objectRule<Map<string, unknown>>({
        filter: (path) => path.length === 0,
        create: () => envelope,
        add: (fields, key, value) => {
          if (
            key === 'schemaVersion' ||
            key === 'hostId' ||
            OBJECT_SECTIONS.some((field) => key === field) ||
            ARRAY_SECTIONS.some((field) => key === field)
          ) {
            fields.set(key, value)
          }
        }
      }),
      ...OBJECT_SECTIONS.map((section) =>
        objectRule<null>({
          filter: (path) => path.length === 1 && path[0] === section,
          create: () => begin(section),
          add: (_, key, value) => add(section, key, value),
          finalize: end
        })
      ),
      discard
    ],
    arrayRules: [
      ...ARRAY_SECTIONS.map((section) =>
        arrayRule<null>({
          filter: (path) => path.length === 1 && path[0] === section,
          create: () => begin(section),
          add: (_, value) => add(section, String(arrayIndex++), value),
          finalize: end
        })
      ),
      discard
    ]
  })
  const parser = createJsonTokenReader(
    (token) => assembler.consume(token),
    CHUNK_BYTES,
    () =>
      activeSection !== undefined ||
      (assembler.depth === 1 && (assembler.key === 'schemaVersion' || assembler.key === 'hostId'))
  )
  const decoder = new StringDecoder('utf8')
  const parse = (consume: () => void): void => {
    if (malformed) {
      return
    }
    try {
      consume()
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }
      malformed = true
      return
    }
    if (pending.length > 0) {
      runJournalTransaction(db, () => {
        for (const { section, entry } of pending) {
          checkCancellation()
          if (entry) {
            insert.run(generation, section, entry.key, entry.body, Number(entry.readable))
          } else {
            clear.run(generation, section)
          }
        }
      })
      pending.length = 0
    }
  }
  await readStableRecordFile(
    file,
    (bytes) => parse(() => parser.write(decoder.write(bytes))),
    checkCancellation
  )
  parse(() => {
    parser.write(decoder.end())
    parser.end()
  })
  const schema = envelope.get('schemaVersion')
  if (!malformed && assembler.current === envelope && typeof schema === 'number' && schema > 2) {
    throw new AgentSessionJournalError('journal_read_only', 'the original chat records are newer')
  }
  const hostId = envelope.get('hostId')
  const tabs = envelope.has('sessionTabs')
    ? 'sessionTabs'
    : envelope.has('visibleSessionIds')
      ? 'visibleSessionIds'
      : null
  if (
    malformed ||
    assembler.current !== envelope ||
    schema !== 2 ||
    typeof hostId !== 'string' ||
    [...OBJECT_SECTIONS, 'retiredClaimKeys'].some((key) => envelope.get(key) !== stagedSection) ||
    (tabs !== null && envelope.get(tabs) !== stagedSection) ||
    db
      .prepare(`SELECT 1 FROM legacy_rows WHERE generation=? AND
        section IN ('operations','unusableRecords','retiredClaimKeys') AND readable=0 LIMIT 1`)
      .get(generation) ||
    (tabs === 'sessionTabs' && !validateLegacyAgentSessionTabs(db, generation, checkCancellation))
  ) {
    db.prepare('DELETE FROM legacy_rows WHERE generation=?').run(generation)
    return null
  }
  return { generation, hostId, tabs }
}

/** Only absence or malformed content permits recovery from an older copy. */
export async function readJournalLegacyRecordSnapshot(
  files: readonly [RecordFile, RecordFile],
  stage: Database.Database,
  checkCancellation: () => void
): Promise<JournalLegacyRecordSnapshot | 'corrupt'> {
  checkCancellation()
  const [primary, backup] = files
  if (primary.identity === null && backup.identity === null) {
    return null
  }
  const latest =
    primary.identity === null
      ? null
      : await stageRecordFile(stage, primary, 'primary', checkCancellation)
  const needsSalvage =
    latest &&
    stage
      .prepare(`SELECT 1 FROM legacy_rows p
    WHERE p.generation='primary' AND (p.section='unusableRecords' OR (p.section='records' AND p.readable=0))
    AND NOT EXISTS (SELECT 1 FROM legacy_rows r WHERE r.generation='primary' AND r.section='records' AND r.key=p.key AND r.readable=1)
    LIMIT 1`)
      .get()
  const recovered =
    backup.identity !== null && (!latest || needsSalvage)
      ? await stageRecordFile(stage, backup, 'backup', checkCancellation)
      : null
  assertJournalLegacyRecordFilesStable(files)
  checkCancellation()
  if (latest) {
    return { ...latest, salvage: recovered !== null }
  }
  if (recovered) {
    return { ...recovered, salvage: false, tabs: null }
  }
  return 'corrupt'
}
