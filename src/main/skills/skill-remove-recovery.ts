import { lstat, readlink, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import type { SkillPlacementResult } from '../../shared/skill-install-contract'
import type { SkillInstallFilesystem } from './skill-install-filesystem'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'
import {
  skillInstallStateKey,
  writeSkillInstallReceipt,
  type SkillInstallReceiptV1
} from './skill-install-provenance'

export type RemovalMove = {
  sourcePath: string
  backupPath: string
  placement: SkillPlacementResult
  expectedDigest?: string
  expectedAliasTarget?: string
}

export type SkillRemovalJournalV1 = {
  schemaVersion: 1
  operation: 'remove'
  phase: 'prepared' | 'moving' | 'receipt-removed'
  canonicalPath: string
  movedCount: number
  moves: RemovalMove[]
  receipt: SkillInstallReceiptV1
  allowedProviderRoots: string[]
}

const SKILL_TRANSACTION_JOURNAL_MAX_BYTES = 4 * 1024 * 1024

export function skillRemovalJournalPath(stateDirectory: string, canonicalPath: string): string {
  return join(stateDirectory, 'removal-journals', `${skillInstallStateKey(canonicalPath)}.json`)
}

function validBackup(move: RemovalMove): boolean {
  return (
    typeof move?.sourcePath === 'string' &&
    typeof move.backupPath === 'string' &&
    Boolean(move.placement) &&
    typeof move.placement.path === 'string' &&
    typeof move.placement.topology === 'string' &&
    dirname(move.sourcePath) === dirname(move.backupPath) &&
    basename(move.backupPath).startsWith(`.${basename(move.sourcePath)}.orca-remove-backup-`)
  )
}

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function pathInside(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(child)
  )
}

function moveOwnedByJournal(journal: Partial<SkillRemovalJournalV1>, move: RemovalMove): boolean {
  if (!journal.receipt || !Array.isArray(journal.allowedProviderRoots)) {
    return false
  }
  const canonical = normalizedPath(journal.canonicalPath!)
  const source = normalizedPath(move.sourcePath)
  if (source === canonical) {
    return (
      move.placement.topology === 'canonical-copy' &&
      typeof move.expectedDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(move.expectedDigest)
    )
  }
  const receiptPlacement = journal.receipt.placements.find(
    (placement) => normalizedPath(placement.path) === source
  )
  return Boolean(
    receiptPlacement &&
    receiptPlacement.topology === move.placement.topology &&
    journal.allowedProviderRoots.some(
      (root) =>
        pathInside(root, move.sourcePath) &&
        normalizedPath(move.sourcePath) ===
          normalizedPath(join(root, basename(journal.canonicalPath!)))
    ) &&
    (move.placement.topology === 'provider-alias'
      ? move.expectedAliasTarget === journal.canonicalPath
      : move.expectedDigest === journal.receipt.packageDigest)
  )
}

function isRemovalJournal(value: unknown, canonicalPath: string): value is SkillRemovalJournalV1 {
  if (!value || typeof value !== 'object') {
    return false
  }
  const journal = value as Partial<SkillRemovalJournalV1>
  return (
    journal.schemaVersion === 1 &&
    journal.operation === 'remove' &&
    journal.canonicalPath === canonicalPath &&
    (journal.phase === 'prepared' ||
      journal.phase === 'moving' ||
      journal.phase === 'receipt-removed') &&
    Number.isInteger(journal.movedCount) &&
    Array.isArray(journal.moves) &&
    Boolean(journal.receipt) &&
    journal.receipt?.canonicalPath === canonicalPath &&
    Array.isArray(journal.allowedProviderRoots) &&
    journal.moves.every((move) => validBackup(move) && moveOwnedByJournal(journal, move)) &&
    new Set(journal.moves.map((move) => normalizedPath(move.sourcePath))).size ===
      journal.moves.length &&
    journal.movedCount! >= 0 &&
    journal.movedCount! <= journal.moves.length
  )
}

async function movedBackupMatches(
  move: RemovalMove,
  receipt: SkillInstallReceiptV1,
  filesystem: SkillInstallFilesystem
): Promise<boolean> {
  if (move.expectedAliasTarget) {
    if (filesystem.aliasTargets) {
      return filesystem.aliasTargets(move.expectedAliasTarget, move.backupPath)
    }
    const target = await readlink(move.backupPath).catch(() => null)
    return Boolean(
      target &&
      normalizedPath(resolve(dirname(move.backupPath), target)) ===
        normalizedPath(move.expectedAliasTarget)
    )
  }
  if (!move.expectedDigest) {
    return false
  }
  const observed = await filesystem
    .observeSkill(move.backupPath, receipt.fileModes)
    .catch(() => null)
  return observed?.observedDigest === move.expectedDigest
}

export async function readSkillRemovalRecoveryJournal(
  stateDirectory: string,
  canonicalPath: string
): Promise<SkillRemovalJournalV1 | null> {
  try {
    const value: unknown = JSON.parse(
      (
        await readNodeFileWithinLimit(
          skillRemovalJournalPath(stateDirectory, canonicalPath),
          SKILL_TRANSACTION_JOURNAL_MAX_BYTES
        )
      ).buffer.toString('utf8')
    )
    if (!isRemovalJournal(value, canonicalPath)) {
      throw new Error('skill-removal-journal-invalid')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function skillRemovalPathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null))
}

export async function recoverSkillRemovalTransaction(
  stateDirectory: string,
  canonicalPath: string,
  filesystem: SkillInstallFilesystem = nativeSkillInstallFilesystem
): Promise<void> {
  const journal = await readSkillRemovalRecoveryJournal(stateDirectory, canonicalPath)
  if (!journal) {
    return
  }
  if (journal.phase === 'receipt-removed') {
    for (const move of journal.moves.slice(0, journal.movedCount)) {
      if (!(await movedBackupMatches(move, journal.receipt, filesystem))) {
        throw new Error('skill-removal-recovery-conflict')
      }
      await filesystem.remove(move.backupPath)
    }
    await rm(skillRemovalJournalPath(stateDirectory, canonicalPath), { force: true })
    return
  }
  const moved = journal.moves.slice(0, journal.movedCount)
  for (let index = moved.length - 1; index >= 0; index -= 1) {
    const move = moved[index]
    if (!move) {
      continue
    }
    if (
      (await skillRemovalPathExists(move.backupPath)) &&
      !(await skillRemovalPathExists(move.sourcePath))
    ) {
      if (!(await movedBackupMatches(move, journal.receipt, filesystem))) {
        throw new Error('skill-removal-recovery-conflict')
      }
      await filesystem.rename(move.backupPath, move.sourcePath)
    }
  }
  await writeSkillInstallReceipt(stateDirectory, journal.receipt)
  await rm(skillRemovalJournalPath(stateDirectory, canonicalPath), { force: true })
}
