import { existsSync } from 'node:fs'
import type {
  ProfileStateAuthority,
  ProfileStateAuthorityInitialState,
  ProfileStateDomainReplacement,
  ProfileStateMaintenance
} from '../loading-store/profile-state-authority'
import {
  importProfileStateJson,
  readAcceptedProfileStateParsedSnapshot,
  readProfileStateParsedSnapshot,
  readProfileStateRevision,
  readProfileStateSnapshot
} from './profile-state-documents'
import {
  openWritableProfileStateDatabase,
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
import { assertProfileStateRevisionOnDisk } from './profile-state-revision-readmission'
import {
  quarantineProfileStateDatabase,
  type ProfileStateDatabaseQuarantine
} from './profile-state-database-quarantine'
import {
  writeProfileStateAuthorityJsonExport,
  writeProfileStateAuthorityCompatibilityExport,
  writeProfileStateAuthorityCompatibilityExportAsync
} from './legacy-json/profile-state-authority-exports'
import { buildCompleteDocumentReplacements } from './profile-state-complete-replacements'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import type { ProfileStateWriterInitialization } from './profile-state-writer-protocol'

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
  private retired = false
  private observedRevision: number | undefined
  private writableDatabase: ReturnType<typeof openWritableProfileStateDatabase> | undefined
  private backupRotation: ProfileStateBackupRotation | undefined

  constructor(
    private readonly databasePath: string,
    private readonly profileId: string
  ) {}

  retireForWorker(): ProfileStateWriterInitialization {
    this.assertActive()
    if (this.observedRevision === undefined || this.backupRotation !== undefined) {
      throw new Error('Profile state worker handoff requires an admitted bootstrap authority')
    }
    const initialization = {
      databasePath: this.databasePath,
      profileId: this.profileId,
      revision: this.observedRevision
    }
    this.close()
    this.retired = true
    return initialization
  }

  initializeFromRevision(revision: number): void {
    this.assertActive()
    if (this.observedRevision !== undefined || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('Invalid profile state worker revision handoff')
    }
    assertProfileStateRevisionOnDisk(this.databasePath, this.profileId, revision)
    this.observedRevision = revision
    this.assertCurrentRevision()
  }

  get revision(): number {
    this.assertActive()
    if (this.observedRevision === undefined) {
      throw new Error('Profile state authority has no admitted revision')
    }
    return this.observedRevision
  }

  /** Keep the startup payload and write fence on the same accepted revision. */
  readAcceptedState(
    rawJson: string
  ): ProfileStateAuthorityInitialState<ProfileStateSqliteAuthority> | undefined {
    this.assertActive()
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

  readInitialState(): ProfileStateAuthorityInitialState<ProfileStateSqliteAuthority> {
    this.assertActive()
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
    this.assertActive()
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

  writeSerializedDomains(
    replacements: readonly ProfileStateDomainReplacement[],
    automationRunsAfter?: readonly unknown[]
  ): void {
    this.assertActive()
    if (this.observedRevision === undefined) {
      // Store normally reads before its first write. Establishing the revision
      // here keeps direct authority callers fenced too.
      this.readSerializedState()
    }
    const opened = this.openWritableDatabase()
    this.observedRevision = writeProfileStateDomains(opened.db, {
      expectedRevision: this.observedRevision ?? 0,
      replacements,
      automationRunsAfter
    }).revision
  }

  assertCurrentRevision(): void {
    const actualRevision = readProfileStateRevision(this.openWritableDatabase().db)
    if (this.observedRevision === undefined || actualRevision !== this.observedRevision) {
      throw new ProfileStateRevisionConflictError(this.observedRevision ?? 0, actualRevision)
    }
  }

  writeSerializedAutomationRuns(
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly unknown[]
  ): void {
    this.writeSerializedDomains(replacements, runs)
  }

  writeSerializedState(payload: Buffer): void {
    this.assertActive()
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
    this.assertActive()
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
    this.observedRevision = writeProfileStateDomains(opened.db, {
      expectedRevision: this.observedRevision ?? currentRevision,
      replacements: complete
    }).revision
  }

  scheduleBackup(): void {
    this.assertActive()
    this.backupRotation ??= new ProfileStateBackupRotation(this.databasePath, this.profileId)
    this.backupRotation.schedule()
  }

  async drainBackups(): Promise<void> {
    this.assertActive()
    await this.backupRotation?.drain()
  }

  writeJsonExport(targetPath: string): number {
    return writeProfileStateAuthorityJsonExport(
      this.openWritableDatabase().db,
      targetPath,
      this.observedRevision
    )
  }

  writeJsonCompatibilityExport(targetPath: string): number | undefined {
    return writeProfileStateAuthorityCompatibilityExport(
      this.openWritableDatabase().db,
      targetPath,
      this.observedRevision
    )
  }

  writeJsonCompatibilityExportAsync(targetPath: string): Promise<number | undefined> {
    return writeProfileStateAuthorityCompatibilityExportAsync(
      this.openWritableDatabase().db,
      targetPath,
      this.observedRevision
    )
  }

  quarantineDatabase(quarantineRoot?: string, reason?: string): ProfileStateDatabaseQuarantine {
    this.assertActive()
    this.backupRotation?.assertIdle()
    this.close()
    return quarantineProfileStateDatabase(this.databasePath, this.profileId, quarantineRoot, reason)
  }

  close(): void {
    this.assertActive()
    this.backupRotation?.stop()
    this.writableDatabase?.db.close()
    this.writableDatabase = undefined
  }

  async pauseForMaintenance(): Promise<ProfileStateMaintenance> {
    const revision = this.revision
    await this.drainBackups()
    this.close()
    let consumed = false
    return {
      resume: async () => {
        if (consumed) {
          throw new Error('Profile maintenance resume has already been consumed')
        }
        consumed = true
        assertProfileStateRevisionOnDisk(this.databasePath, this.profileId, revision)
        this.assertCurrentRevision()
        this.backupRotation = undefined
      }
    }
  }

  private createInitialState(
    revision: number,
    value: Record<string, unknown> | undefined
  ): ProfileStateAuthorityInitialState<ProfileStateSqliteAuthority> {
    let pending: { revision: number; value: Record<string, unknown> | undefined } | undefined = {
      revision,
      value
    }
    this.observedRevision = revision
    return {
      authority: this,
      takeParsedState: () => {
        this.assertActive()
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

  private assertActive(): void {
    if (this.retired) {
      throw new Error('Profile state authority was retired for worker ownership')
    }
  }

  private openWritableDatabase(): NonNullable<ProfileStateSqliteAuthority['writableDatabase']> {
    this.assertActive()
    this.writableDatabase ??= openWritableProfileStateDatabase(this.databasePath, this.profileId)
    return this.writableDatabase
  }
}
