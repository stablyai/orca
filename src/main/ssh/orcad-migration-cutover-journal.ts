/**
 * The cutover journal sidecar: one durable, owner-only file per migration beside the profile.
 *
 * Why not the profile store: shipped builds rewrite orca-data.json and the profile database with
 * schemas that drop unknown fields, so a journal kept there would vanish across a downgrade while
 * the target's `orcadFence`, which shipped builds keep, survived it. A missing journal must
 * never look like "no migration"; an unreadable one fails closed.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS,
  isRetainedOrcadMigrationSourceCutover,
  parseOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import { syncDirectoryDurablySync } from '../durable-file-write'
import { errorMessage } from '../../shared/error-message'

const JOURNAL_DIRECTORY = 'orcad-migration-cutovers'
const JOURNAL_FILE = /^[A-Za-z0-9_-]{1,128}\.json$/
// A manifest carries catalog rows and dormant session state, never scrollback bytes.
const MAX_JOURNAL_FILE_BYTES = 16 * 1024 * 1024

export class OrcadMigrationCutoverJournalUnreadableError extends Error {
  constructor(detail: string) {
    super(`The migration journal cannot be read, so the SSH host stays fenced: ${detail}`)
    this.name = 'OrcadMigrationCutoverJournalUnreadableError'
  }
}

type JournalChangeListener = (userDataPath: string) => void
let journalChangeListener: JournalChangeListener | null = null

/** Persistence state that follows the journal (scrollback retention) re-syncs on every change. */
export function setOrcadMigrationJournalChangeListener(
  listener: JournalChangeListener | null
): void {
  journalChangeListener = listener
}

function notifyJournalChanged(userDataPath: string): void {
  try {
    journalChangeListener?.(userDataPath)
  } catch (error) {
    // The journal write is already durable; a follower failing must not undo or fail it.
    console.warn('[orcad-migration] Journal change follower failed:', error)
  }
}

// Why: hidden-row checks run on every list call, and each journal embeds a full manifest.
const parsedJournals = new Map<string, { key: string; cutovers: OrcadMigrationSourceCutover[] }>()

export function orcadMigrationCutoverJournalDirectory(userDataPath: string): string {
  return join(userDataPath, JOURNAL_DIRECTORY)
}

/** Every journaled cutover; throws rather than skipping a file it cannot trust. */
export function listOrcadMigrationSourceCutovers(
  userDataPath: string
): OrcadMigrationSourceCutover[] {
  const directory = orcadMigrationCutoverJournalDirectory(userDataPath)
  if (!existsSync(directory)) {
    return []
  }
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    throw new OrcadMigrationCutoverJournalUnreadableError(errorMessage(error))
  }
  const files: { name: string; path: string }[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue // Durable-write temporaries and foreign files carry no journal state.
    }
    if (!JOURNAL_FILE.test(name)) {
      throw new OrcadMigrationCutoverJournalUnreadableError(`unexpected entry ${name}`)
    }
    files.push({ name, path: join(directory, name) })
  }
  const key = files.map((file) => `${file.name}:${fileVersion(file.path)}`).join('|')
  const cached = parsedJournals.get(directory)
  if (cached?.key === key) {
    return [...cached.cutovers]
  }
  const cutovers = files.map((file) =>
    readJournalFile(file.path, file.name.slice(0, -'.json'.length))
  )
  parsedJournals.set(directory, { key, cutovers })
  return [...cutovers]
}

/** The target's current cutover: the head of its chain, which no later delta move supersedes. */
export function findOrcadMigrationSourceCutoverForTarget(
  userDataPath: string,
  sshTargetId: string
): OrcadMigrationSourceCutover | null {
  const chain = listOrcadMigrationCutoverChainForTarget(userDataPath, sshTargetId)
  return chain.at(-1) ?? null
}

/** Oldest first; throws unless the target's journals form one chain of delta moves. */
export function listOrcadMigrationCutoverChainForTarget(
  userDataPath: string,
  sshTargetId: string
): OrcadMigrationSourceCutover[] {
  const matches = listOrcadMigrationSourceCutovers(userDataPath).filter(
    (cutover) => cutover.sshTargetId === sshTargetId
  )
  const superseded = new Set(matches.map((cutover) => cutover.supersedesMigrationId))
  const heads = matches.filter((cutover) => !superseded.has(cutover.migrationId))
  if (heads.length > 1) {
    throw new OrcadMigrationCutoverJournalUnreadableError(
      `${heads.length} journals name SSH target ${sshTargetId}`
    )
  }
  const byId = new Map(matches.map((cutover) => [cutover.migrationId, cutover]))
  const chain: OrcadMigrationSourceCutover[] = []
  let entry: OrcadMigrationSourceCutover | undefined = heads[0]
  while (entry && chain.length <= matches.length) {
    chain.unshift(entry)
    entry = entry.supersedesMigrationId ? byId.get(entry.supersedesMigrationId) : undefined
  }
  if (chain.length !== matches.length) {
    throw new OrcadMigrationCutoverJournalUnreadableError(
      `the journals naming SSH target ${sshTargetId} do not form one chain`
    )
  }
  return chain
}

/** Durable before it returns: a fence written after this always has its journal on disk. */
export function writeOrcadMigrationSourceCutover(
  userDataPath: string,
  cutover: OrcadMigrationSourceCutover
): void {
  const parsed = parseOrcadMigrationSourceCutover(cutover)
  const existing = listOrcadMigrationSourceCutovers(userDataPath)
  // Why in flight only: a retained cutover is finished and may wait two releases for retirement.
  const inFlight = existing.filter(
    (entry) => entry.phase !== 'source-retired' && !isRetainedOrcadMigrationSourceCutover(entry)
  )
  if (
    !existing.some((entry) => entry.migrationId === parsed.migrationId) &&
    inFlight.length >= MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS
  ) {
    throw new Error('orcad_migration_cutover_capacity_exceeded')
  }
  const directory = orcadMigrationCutoverJournalDirectory(userDataPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeSecureJsonFileWithinLimit(
    join(directory, `${parsed.migrationId}.json`),
    parsed,
    MAX_JOURNAL_FILE_BYTES,
    { durable: true }
  )
  syncDirectoryDurablySync(directory)
  parsedJournals.delete(directory)
  notifyJournalChanged(userDataPath)
}

export function removeOrcadMigrationSourceCutover(userDataPath: string, migrationId: string): void {
  if (!JOURNAL_FILE.test(`${migrationId}.json`)) {
    throw new Error('orcad_migration_cutover_id_invalid')
  }
  const directory = orcadMigrationCutoverJournalDirectory(userDataPath)
  rmSync(join(directory, `${migrationId}.json`), { force: true })
  parsedJournals.delete(directory)
  if (existsSync(directory)) {
    syncDirectoryDurablySync(directory)
  }
  notifyJournalChanged(userDataPath)
}

/** Every journal a host's stopped or never-registered server leaves behind; they grant nothing. */
export function removeOrcadMigrationJournalsForDestination(
  userDataPath: string,
  sshTargetId: string,
  environmentId: string
): void {
  for (const cutover of listOrcadMigrationSourceCutovers(userDataPath)) {
    if (cutover.sshTargetId === sshTargetId && cutover.destinationEnvironmentId === environmentId) {
      removeOrcadMigrationSourceCutover(userDataPath, cutover.migrationId)
    }
  }
}

/** Durable writes replace the file, so size, mtime and inode change with every rewrite. */
function fileVersion(path: string): string {
  try {
    const stat = statSync(path, { bigint: true })
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`
  } catch (error) {
    throw new OrcadMigrationCutoverJournalUnreadableError(errorMessage(error))
  }
}

function readJournalFile(path: string, migrationId: string): OrcadMigrationSourceCutover {
  try {
    const raw = readNodeFileSyncWithinLimit(path, MAX_JOURNAL_FILE_BYTES).buffer.toString('utf8')
    const cutover = parseOrcadMigrationSourceCutover(JSON.parse(raw))
    if (cutover.migrationId !== migrationId) {
      throw new Error('file name does not match its migration id')
    }
    return cutover
  } catch (error) {
    throw new OrcadMigrationCutoverJournalUnreadableError(errorMessage(error))
  }
}
