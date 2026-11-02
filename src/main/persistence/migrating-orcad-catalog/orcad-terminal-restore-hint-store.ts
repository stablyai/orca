/**
 * Installed restore hints on the destination, keyed by paneKey, until the pane's first spawn
 * consumes its hint. A small fsync'd JSON file beside the received blobs rather than profile state:
 * it is host-local, never synced or sent anywhere, and every change must be durable on its own.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import {
  MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS,
  isOrcadMigrationTerminalRestoreHintCwd,
  isOrcadMigrationTerminalRestoreHintPaneKey,
  type OrcadMigrationTerminalRestoreHint
} from '../../../shared/orcad-migration-terminal-restore-hints'
import { ensureOrcadMigrationDirectory } from './orcad-migration-staged-file'

const STORE_VERSION = 2
const INSTALLED_DIRECTORY = 'installed'
const STORE_FILE = 'terminal-restore-hints.json'
// A pane not reopened within a month is not coming back through this migration.
export const ORCAD_TERMINAL_RESTORE_HINT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_INSTALLED_MIGRATIONS = 256

/** A received hint placed in the worktree that owns its pane on this host. */
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
  /** Migrations already installed, so a commit retry never revives a hint a pane consumed. */
  installedMigrationKeys: string[]
}

const MIGRATION_KEY = /^[a-f0-9]{32}$/

const StoreDocumentSchema = z.object({
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

export class OrcadTerminalRestoreHintStore {
  private readonly directory: string
  private readonly path: string
  private document: TerminalRestoreHintStoreDocument | null = null

  constructor(blobRoot: string) {
    this.directory = join(blobRoot, INSTALLED_DIRECTORY)
    this.path = join(this.directory, STORE_FILE)
  }

  hasInstalledMigration(migrationKey: string): boolean {
    return this.load().installedMigrationKeys.includes(migrationKey)
  }

  /** Newer hints replace older ones for the same pane; the oldest drop past the count cap. */
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

  /** The pane's hinted cwd if it was moved into `worktreeId`; never removes it. */
  peek(paneKey: string, worktreeId: string, now: number): string | null {
    const hint = this.load().hints.find((entry) => entry.paneKey === paneKey)
    if (!hint || hint.worktreeId !== worktreeId) {
      return null
    }
    return now - hint.installedAt > ORCAD_TERMINAL_RESTORE_HINT_TTL_MS ? null : hint.cwd
  }

  /** Durably removes the pane's hint, whichever worktree it named; a no-op when it has none. */
  consume(paneKey: string, now: number): void {
    this.dropWhere((hint) => hint.paneKey === paneKey, now)
  }

  /** Drops hints for panes of worktrees this host no longer owns. */
  dropForWorktrees(matchesWorktreeId: (worktreeId: string) => boolean, now: number): void {
    this.dropWhere((hint) => matchesWorktreeId(hint.worktreeId), now)
  }

  private dropWhere(matches: (hint: InstalledTerminalRestoreHint) => boolean, now: number): void {
    const current = this.load()
    if (!current.hints.some(matches)) {
      return
    }
    this.write({ ...current, hints: current.hints.filter((hint) => !matches(hint)) }, now)
  }

  private write(next: TerminalRestoreHintStoreDocument, now: number): void {
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
    this.document = readStoreDocument(this.path)
    return this.document
  }
}

/**
 * For project removal: a removed project's panes never come back by these keys unless a later
 * migration brings them, and that migration carries its own hints. Never blocks the removal.
 */
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

function readStoreDocument(path: string): TerminalRestoreHintStoreDocument {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return emptyDocument()
  }
  try {
    const parsed = StoreDocumentSchema.safeParse(JSON.parse(text))
    if (parsed.success) {
      return {
        version: parsed.data.version,
        hints: parsed.data.hints,
        installedMigrationKeys: parsed.data.installedMigrationKeys
      }
    }
  } catch {
    // Falls through: a torn or foreign file only costs panes their old folder.
  }
  console.warn('[orcad-migration] ignoring an unreadable terminal restore hint store')
  return emptyDocument()
}
