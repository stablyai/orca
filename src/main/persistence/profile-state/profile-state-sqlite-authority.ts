import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  durableWriteTempPath,
  writeFileDurable,
  writeFileDurableSync
} from '../../durable-file-write'
import type {
  ProfileStateAuthority,
  ProfileStateAuthorityInitialState,
  ProfileStateDomainReplacement
} from '../loading-store/profile-state-authority'
import {
  acceptProfileStateJsonCompatibility,
  importProfileStateJson,
  readAcceptedProfileStateParsedSnapshot,
  readProfileStateParsedSnapshot,
  readProfileStateRevision,
  readProfileStateSnapshot,
  stageProfileStateJsonCompatibility
} from './profile-state-documents'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import {
  prepareProfileStateDomainMutation,
  validateProfileStateDomainTransaction
} from './profile-state-domain-write-validation'
import {
  parseProfileStateRoot,
  ProfileStateRevisionConflictError
} from './profile-state-document-validation'
import type { AutomationRun } from '../../../shared/automations-types'
import {
  quarantineProfileStateDatabase,
  type ProfileStateDatabaseQuarantine
} from './profile-state-database-quarantine'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'

/**
 * Complete-document authority for the Store cutover.
 *
 * A Store authority keeps one writable handle for its lifetime so repeated
 * domain commits do not pay connection and pragma setup costs. Store teardown
 * calls {@link close} before profile switches or process removal. Complete
 * payloads use one fenced domain transaction, so unchanged normalized rows are
 * not rebuilt; Store callers can still opt into narrower dirty-domain writes.
 */
export class ProfileStateSqliteAuthority implements ProfileStateAuthority {
  private observedRevision: number | undefined
  private writableDatabase: ReturnType<typeof openProfileStateDatabase> | undefined
  private backupRotation: ProfileStateBackupRotation | undefined

  constructor(
    private readonly databasePath: string,
    private readonly profileId: string
  ) {}

  /** Keep the startup payload and write fence on the same accepted revision. */
  readAcceptedState(rawJson: string): ProfileStateAuthorityInitialState | undefined {
    const opened = openProfileStateDatabaseReadOnly(this.databasePath, this.profileId)
    try {
      const snapshot = readAcceptedProfileStateParsedSnapshot(opened.db, rawJson)
      if (snapshot === undefined) {
        return undefined
      }
      return this.createInitialState(snapshot.revision, snapshot.state)
    } finally {
      opened.db.close()
    }
  }

  readInitialState(): ProfileStateAuthorityInitialState {
    if (!this.writableDatabase && !existsSync(this.databasePath)) {
      return this.createInitialState(0, undefined)
    }
    const opened =
      this.writableDatabase ?? openProfileStateDatabaseReadOnly(this.databasePath, this.profileId)
    try {
      const snapshot = readProfileStateParsedSnapshot(opened.db)
      return this.createInitialState(
        snapshot.revision,
        snapshot.revision === 0 ? undefined : snapshot.state
      )
    } finally {
      if (opened !== this.writableDatabase) {
        opened.db.close()
      }
    }
  }

  readSerializedState(): string | undefined {
    if (!this.writableDatabase && !existsSync(this.databasePath)) {
      // Treat an absent database as the empty revision so a concurrent creator
      // cannot race this authority's first commit.
      this.observedRevision = 0
      return undefined
    }
    const opened =
      this.writableDatabase ?? openProfileStateDatabaseReadOnly(this.databasePath, this.profileId)
    try {
      const snapshot = readProfileStateSnapshot(opened.db)
      this.observedRevision = snapshot.revision
      return snapshot.revision === 0 ? undefined : snapshot.json
    } finally {
      if (opened !== this.writableDatabase) {
        opened.db.close()
      }
    }
  }

  writeSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]): void {
    if (this.observedRevision === undefined) {
      // Store normally reads before its first write. Establishing the revision
      // here keeps direct authority callers fenced too.
      this.readSerializedState()
    }
    const opened = this.openWritableDatabase()
    const result = writeProfileStateDomains(opened.db, {
      expectedRevision: this.observedRevision ?? 0,
      replacements
    })
    this.observedRevision = result.revision
  }

  assertCurrentRevision(): void {
    const actualRevision = readProfileStateRevision(this.openWritableDatabase().db)
    if (this.observedRevision === undefined || actualRevision !== this.observedRevision) {
      throw new ProfileStateRevisionConflictError(this.observedRevision ?? 0, actualRevision)
    }
  }

  writeSerializedAutomationRuns(
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ): void {
    if (this.observedRevision === undefined) {
      this.readSerializedState()
    }
    const opened = this.openWritableDatabase()
    const result = writeProfileStateDomains(opened.db, {
      expectedRevision: this.observedRevision ?? 0,
      replacements,
      automationRunsAfter: runs
    })
    this.observedRevision = result.revision
  }

  writeSerializedState(payload: Buffer): void {
    const serialized = payload.toString('utf8')
    if (!Buffer.from(serialized, 'utf8').equals(payload)) {
      throw new Error('Profile state payload is not valid UTF-8')
    }
    const parsed = parseProfileStateRoot(serialized)
    this.writeCompleteSerializedDomains(
      Object.entries(parsed).map(([domain, value]) => {
        const payload = JSON.stringify(value)
        if (payload === undefined) {
          throw new Error(`Profile state domain payload is not serializable: ${domain}`)
        }
        return { domain, payload }
      })
    )
  }

  writeCompleteSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]): void {
    if (this.observedRevision === undefined) {
      this.readSerializedState()
    }
    if (!Array.isArray(replacements) || replacements.length > 0) {
      validateProfileStateDomainTransaction({
        expectedRevision: this.observedRevision ?? 0,
        replacements
      })
    }
    const opened = this.openWritableDatabase()
    const currentRevision = readProfileStateRevision(opened.db)
    const complete = buildCompleteDocumentReplacements(opened.db, replacements)
    if (currentRevision === 0 || complete.length === 0) {
      // Each fragment must be valid independently before it can become part of a root object.
      for (const replacement of replacements) {
        prepareProfileStateDomainMutation(replacement)
      }
      const rawJson = `{${replacements
        .filter(({ payload }) => payload !== null)
        .map(({ domain, payload }) => `${JSON.stringify(domain)}:${payload}`)
        .join(',')}}`
      this.observedRevision = importProfileStateJson(opened.db, rawJson, {
        expectedRevision: this.observedRevision
      })
      return
    }
    const result = writeProfileStateDomains(opened.db, {
      expectedRevision: this.observedRevision ?? currentRevision,
      replacements: complete
    })
    this.observedRevision = result.revision
  }

  scheduleBackup(): void {
    this.backupRotation ??= new ProfileStateBackupRotation(this.databasePath, this.profileId)
    this.backupRotation.schedule()
  }

  async drainBackups(): Promise<void> {
    await this.backupRotation?.drain()
  }

  /** Publish a durable JSON rollback/compatibility export without changing authority. */
  writeJsonExport(targetPath: string): number {
    const opened = this.openWritableDatabase()
    const snapshot = readProfileStateSnapshot(opened.db)
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileDurableSync(durableWriteTempPath(targetPath), targetPath, snapshot.json)
    return snapshot.revision
  }

  /** Stage both accepted versions before replacing canonical JSON for an older build. */
  writeJsonCompatibilityExport(targetPath: string): number | undefined {
    const opened = this.openWritableDatabase()
    const snapshot = readProfileStateSnapshot(opened.db)
    if (snapshot.revision === 0) {
      return undefined
    }
    const retained = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : undefined
    stageProfileStateJsonCompatibility(opened.db, snapshot.json, snapshot.revision, retained)
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileDurableSync(durableWriteTempPath(targetPath), targetPath, snapshot.json)
    acceptProfileStateJsonCompatibility(opened.db, snapshot.json, snapshot.revision)
    return snapshot.revision
  }

  async writeJsonCompatibilityExportAsync(targetPath: string): Promise<number | undefined> {
    const opened = this.openWritableDatabase()
    const snapshot = readProfileStateSnapshot(opened.db)
    if (snapshot.revision === 0) {
      return undefined
    }
    const retained = await readFile(targetPath, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    })
    stageProfileStateJsonCompatibility(opened.db, snapshot.json, snapshot.revision, retained)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFileDurable(durableWriteTempPath(targetPath), targetPath, snapshot.json)
    acceptProfileStateJsonCompatibility(opened.db, snapshot.json, snapshot.revision)
    return snapshot.revision
  }

  quarantineDatabase(quarantineRoot?: string, reason?: string): ProfileStateDatabaseQuarantine {
    this.backupRotation?.assertIdle()
    this.close()
    return quarantineProfileStateDatabase(this.databasePath, this.profileId, quarantineRoot, reason)
  }

  close(): void {
    this.backupRotation?.stop()
    this.writableDatabase?.db.close()
    this.writableDatabase = undefined
  }

  private createInitialState(
    revision: number,
    value: Record<string, unknown> | undefined
  ): ProfileStateAuthorityInitialState {
    let pending: { revision: number; value: Record<string, unknown> | undefined } | undefined = {
      revision,
      value
    }
    this.observedRevision = revision
    return {
      authority: this,
      takeParsedState: () => {
        const snapshot = pending
        if (snapshot === undefined) {
          throw new Error('Profile state startup snapshot has already been consumed')
        }
        pending = undefined
        this.observedRevision = snapshot.revision
        return snapshot.value
      }
    }
  }

  private openWritableDatabase(): NonNullable<ProfileStateSqliteAuthority['writableDatabase']> {
    if (this.writableDatabase) {
      return this.writableDatabase
    }
    mkdirSync(dirname(this.databasePath), { recursive: true })
    const opened = openProfileStateDatabase(this.databasePath, this.profileId)
    if (opened.readOnly) {
      opened.db.close()
      throw new Error('Cannot write a future profile state schema')
    }
    this.writableDatabase = opened
    return opened
  }
}

function buildCompleteDocumentReplacements(
  db: ReturnType<typeof openProfileStateDatabase>['db'],
  replacements: readonly ProfileStateDomainReplacement[]
): ProfileStateDomainReplacement[] {
  const domains = new Set(replacements.map(({ domain }) => domain))
  const incoming = new Set(domains)
  for (const row of db
    .prepare(`SELECT domain FROM profile_state_documents
      UNION SELECT domain FROM profile_state_automation_runs_meta WHERE presence <> 'document'`)
    .all()) {
    if (isDomainRow(row)) {
      domains.add(row.domain)
    }
  }

  return [
    ...replacements,
    ...[...domains]
      .filter((domain) => !incoming.has(domain))
      .map((domain) => ({ domain, payload: null }))
  ]
}

function isDomainRow(value: unknown): value is { domain: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'domain' in value &&
    typeof value.domain === 'string' &&
    value.domain.length > 0
  )
}
