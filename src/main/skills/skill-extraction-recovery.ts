import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { writeSkillStateFile } from './skill-install-provenance'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from './skill-install-filesystem'
import { WslSkillInstallFilesystem } from './skill-wsl-install-filesystem'

const MAX_PENDING_EXTRACTIONS = 64
const MAX_EXTRACTION_JOURNAL_BYTES = 64 * 1024
const OWNER_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type SkillExtractionJournalV1 = {
  schemaVersion: 1
  operation: 'extract'
  ownerToken: string
  destinationRoot: string
  extractionPath: string
  wslDistro?: string
}

export type SkillExtractionRecoveryReport = {
  scanned: number
  recovered: number
  failures: { journalKey: string; code: string }[]
  truncated: boolean
}

function journalPath(stateDirectory: string, ownerToken: string): string {
  return join(stateDirectory, 'extraction-journals', `${ownerToken}.json`)
}

function normalized(path: string): string {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value
}

function isJournal(value: unknown, ownerToken: string): value is SkillExtractionJournalV1 {
  if (!value || typeof value !== 'object') {
    return false
  }
  const journal = value as Partial<SkillExtractionJournalV1>
  return (
    journal.schemaVersion === 1 &&
    journal.operation === 'extract' &&
    journal.ownerToken === ownerToken &&
    OWNER_TOKEN.test(ownerToken) &&
    typeof journal.destinationRoot === 'string' &&
    typeof journal.extractionPath === 'string' &&
    journal.destinationRoot.length <= 32_768 &&
    journal.extractionPath.length <= 32_768 &&
    normalized(dirname(journal.extractionPath)) === normalized(journal.destinationRoot) &&
    basename(journal.extractionPath) === `.orca-skill-extract-${ownerToken}` &&
    (journal.wslDistro === undefined ||
      (typeof journal.wslDistro === 'string' &&
        journal.wslDistro.length > 0 &&
        journal.wslDistro.length <= 256))
  )
}

function filesystemFor(journal: SkillExtractionJournalV1): SkillInstallFilesystem {
  if (!journal.wslDistro) {
    return nativeSkillInstallFilesystem
  }
  if (process.platform !== 'win32') {
    throw new Error('skill-transaction-wsl-recovery-unavailable')
  }
  return new WslSkillInstallFilesystem(journal.wslDistro, [journal.destinationRoot])
}

export async function beginSkillExtractionRecovery(
  stateDirectory: string,
  destinationRoot: string,
  wslDistro?: string
): Promise<SkillExtractionJournalV1> {
  const ownerToken = randomUUID()
  const journal: SkillExtractionJournalV1 = {
    schemaVersion: 1,
    operation: 'extract',
    ownerToken,
    destinationRoot,
    extractionPath: join(destinationRoot, `.orca-skill-extract-${ownerToken}`),
    ...(wslDistro ? { wslDistro } : {})
  }
  await writeSkillStateFile(journalPath(stateDirectory, ownerToken), journal)
  return journal
}

export async function finishSkillExtractionRecovery(
  stateDirectory: string,
  journal: SkillExtractionJournalV1,
  filesystem: SkillInstallFilesystem
): Promise<void> {
  await filesystem.remove(journal.extractionPath)
  await rm(journalPath(stateDirectory, journal.ownerToken), { force: true })
}

export async function recoverPendingSkillExtractions(
  stateDirectory: string
): Promise<SkillExtractionRecoveryReport> {
  const directory = join(stateDirectory, 'extraction-journals')
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
  const report: SkillExtractionRecoveryReport = {
    scanned: 0,
    recovered: 0,
    failures: [],
    truncated: files.length > MAX_PENDING_EXTRACTIONS
  }
  for (const entry of files.slice(0, MAX_PENDING_EXTRACTIONS)) {
    const journalKey = entry.name.slice(0, -'.json'.length)
    report.scanned += 1
    try {
      const parsed: unknown = JSON.parse(
        (
          await readNodeFileWithinLimit(join(directory, entry.name), MAX_EXTRACTION_JOURNAL_BYTES)
        ).buffer.toString('utf8')
      )
      if (!isJournal(parsed, journalKey)) {
        throw new Error('skill-extraction-journal-invalid')
      }
      await finishSkillExtractionRecovery(stateDirectory, parsed, filesystemFor(parsed))
      report.recovered += 1
    } catch (error) {
      report.failures.push({
        journalKey,
        code:
          error instanceof Error && /^skill-[a-z0-9-]+$/.test(error.message)
            ? error.message
            : 'skill-extraction-recovery-failed'
      })
    }
  }
  return report
}
