// Host-local hints need independent durable writes until each pane's first spawn consumes them.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import { durableWriteTempPath, writeFileDurableSync } from '../../../filesystem/durable-file-write'
import {
  MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS,
  isOrcadMigrationTerminalRestoreHintCwd,
  isOrcadMigrationTerminalRestoreHintPaneKey,
  type OrcadMigrationTerminalRestoreHint
} from '../../../../shared/orcad-migration/orcad-migration-terminal-restore-hints'
import { ensureOrcadMigrationDirectory } from '../blob-transfer/orcad-migration-staged-file'

const STORE_VERSION = 2
const INSTALLED_DIRECTORY = 'installed'
const STORE_FILE = 'terminal-restore-hints.json'
// Bound retention for panes never reopened after migration.
export const ORCAD_TERMINAL_RESTORE_HINT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_INSTALLED_MIGRATIONS = 256

export type OrcadTerminalRestoreHintPlacement = OrcadMigrationTerminalRestoreHint & {
  worktreeId: string
}

export type OrcadTerminalRestoreHintMigration = {
  migrationKey: string
  migrationId: string
}

type InstalledTerminalRestoreHint = OrcadTerminalRestoreHintPlacement &
  OrcadTerminalRestoreHintMigration & { installedAt: number }

type TerminalRestoreHintStoreDocument = {
  version: typeof STORE_VERSION
  hints: InstalledTerminalRestoreHint[]
  /** Prevent commit retries from reviving already-consumed hints. */
  installedMigrationKeys: string[]
}

const MIGRATION_KEY = /^[a-f0-9]{32}$/

const NewerStoreVersionSchema = lazyZodSchema(() =>
  z.object({ version: z.number().gt(STORE_VERSION) })
)

const StoreDocumentSchema = lazyZodSchema(() =>
  z.object({
    version: z.literal(STORE_VERSION),
    hints: z.array(
      z.object({
        paneKey: z.string().refine(isOrcadMigrationTerminalRestoreHintPaneKey),
        cwd: z.string().refine(isOrcadMigrationTerminalRestoreHintCwd),
        worktreeId: z.string().min(1),
        migrationKey: z.string().regex(MIGRATION_KEY),
        migrationId: z.string().min(1),
        installedAt: z.number().int().nonnegative()
      })
    ),
    installedMigrationKeys: z.array(z.string().regex(MIGRATION_KEY))
  })
)

export class OrcadTerminalRestoreHintStore {
  private readonly directory: string
  private readonly path: string
  private document: TerminalRestoreHintStoreDocument | null = null
  private writtenByNewerBuild = false

  constructor(blobRoot: string) {
    this.directory = join(blobRoot, INSTALLED_DIRECTORY)
    this.path = join(this.directory, STORE_FILE)
  }

  hasInstalledMigration(migrationKey: string): boolean {
    return this.load().installedMigrationKeys.includes(migrationKey)
  }

  install(
    migration: OrcadTerminalRestoreHintMigration,
    hints: readonly OrcadTerminalRestoreHintPlacement[],
    now: number
  ): void {
    const current = this.load()
    if (current.installedMigrationKeys.includes(migration.migrationKey)) {
      return
    }
    const incoming = new Set(hints.map((hint) => hint.paneKey))
    const merged = [
      ...current.hints.filter((hint) => !incoming.has(hint.paneKey)),
      ...hints.map((hint) => ({
        paneKey: hint.paneKey,
        cwd: hint.cwd,
        worktreeId: hint.worktreeId,
        migrationKey: migration.migrationKey,
        migrationId: migration.migrationId,
        installedAt: now
      }))
    ]
    this.write(
      {
        version: STORE_VERSION,
        hints: merged.slice(-MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS),
        installedMigrationKeys: [...current.installedMigrationKeys, migration.migrationKey].slice(
          -MAX_INSTALLED_MIGRATIONS
        )
      },
      now
    )
  }

  /** Read without consuming. */
  peek(paneKey: string, worktreeId: string, now: number): string | null {
    const current = this.tryLoad()
    if (!current) {
      return null
    }
    const hint = current.hints.find((entry) => entry.paneKey === paneKey)
    if (!hint || hint.worktreeId !== worktreeId) {
      return null
    }
    return now - hint.installedAt > ORCAD_TERMINAL_RESTORE_HINT_TTL_MS ? null : hint.cwd
  }

  /** Durably consume regardless of the hint's worktree. */
  consume(paneKey: string, now: number): void {
    const current = this.tryLoad()
    if (!current) {
      return
    }
    this.dropMatching(current, (hint) => hint.paneKey === paneKey, now)
  }

  dropForWorktrees(matchesWorktreeId: (worktreeId: string) => boolean, now: number): void {
    this.dropMatching(this.load(), (hint) => matchesWorktreeId(hint.worktreeId), now)
  }

  private dropMatching(
    current: TerminalRestoreHintStoreDocument,
    matches: (hint: InstalledTerminalRestoreHint) => boolean,
    now: number
  ): void {
    if (!current.hints.some(matches)) {
      return
    }
    this.write({ ...current, hints: current.hints.filter((hint) => !matches(hint)) }, now)
  }

  private tryLoad(): TerminalRestoreHintStoreDocument | null {
    try {
      return this.load()
    } catch (error) {
      console.warn('[orcad-migration] terminal restore hint store transiently unreadable:', error)
      return null
    }
  }

  private write(next: TerminalRestoreHintStoreDocument, now: number): void {
    if (this.writtenByNewerBuild) {
      throw new Error('terminal restore hint store was written by a newer Orca build')
    }
    const document = {
      ...next,
      hints: next.hints.filter(
        (hint) => now - hint.installedAt <= ORCAD_TERMINAL_RESTORE_HINT_TTL_MS
      )
    }
    ensureOrcadMigrationDirectory(this.directory)
    writeFileDurableSync(
      durableWriteTempPath(this.path),
      this.path,
      JSON.stringify(document),
      0o600
    )
    this.document = document
  }

  private load(): TerminalRestoreHintStoreDocument {
    if (this.document) {
      return this.document
    }
    const read = readStoreDocument(this.path)
    this.writtenByNewerBuild = read === 'newer-build'
    this.document = read === 'newer-build' ? emptyDocument() : read
    return this.document
  }
}

/** Project removal is best-effort; any later migration supplies fresh hints. */
export function dropOrcadTerminalRestoreHintsForWorktrees(
  store: OrcadTerminalRestoreHintStore,
  matchesWorktreeId: (worktreeId: string) => boolean
): void {
  try {
    store.dropForWorktrees(matchesWorktreeId, Date.now())
  } catch (error) {
    console.warn('[orcad-migration] dropping terminal restore hints failed:', error)
  }
}

function emptyDocument(): TerminalRestoreHintStoreDocument {
  return { version: STORE_VERSION, hints: [], installedMigrationKeys: [] }
}

/** A newer build's file is never replaced; a damaged one only loses old cwd restoration. */
function readStoreDocument(path: string): TerminalRestoreHintStoreDocument | 'newer-build' {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return emptyDocument()
    }
    // Rethrow failures uncached, so no write replaces hints this read never saw.
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return unreadableStore()
  }
  const parsed = StoreDocumentSchema.safeParse(value)
  if (parsed.success) {
    return {
      version: parsed.data.version,
      hints: parsed.data.hints,
      installedMigrationKeys: parsed.data.installedMigrationKeys
    }
  }
  if (NewerStoreVersionSchema.safeParse(value).success) {
    console.warn('[orcad-migration] keeping a terminal restore hint store from a newer Orca build')
    return 'newer-build'
  }
  return unreadableStore()
}

function unreadableStore(): TerminalRestoreHintStoreDocument {
  console.warn('[orcad-migration] ignoring an unreadable terminal restore hint store')
  return emptyDocument()
}
