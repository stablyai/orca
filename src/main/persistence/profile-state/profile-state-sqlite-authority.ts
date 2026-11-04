import { writeCompleteProfileStateDomains } from './profile-state-complete-domain-write'
import type { JournalPersistenceEffect } from '../../native-chat/agent-session-journal/journal-persistence-plan'
import type Database from '../../sqlite/sync-database'
import { profileStateMaintenance } from './profile-state-maintenance'
import {
  executeSurfaceJointTransaction,
  type SurfaceJointTransaction
} from '../../workspace-surfaces/surface-joint-transaction'
import { createProfileStateStartupTransfer } from '../loading-store/profile-state-startup-transfer'
import { existsSync } from 'node:fs'
import type {
  ProfileStateAuthority,
  ProfileStateAuthorityInitialState,
  ProfileStateDomainReplacement,
  ProfileStateMaintenance
} from '../loading-store/profile-state-authority'
import {
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
import { ProfileStateRevisionConflictError } from './profile-state-document-validation'
import { assertProfileStateRevisionOnDisk } from './profile-state-revision-readmission'
import {
  quarantineProfileStateDatabase,
  type ProfileStateDatabaseQuarantine
} from './profile-state-database-quarantine'
import { writeProfileStateAuthorityJsonExport } from './legacy-json/profile-state-authority-exports'
import { serializedProfileDomainReplacements } from './profile-state-complete-replacements'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import { ensureProfileStateAuthorityMarker } from './profile-state-authority-marker'
import type { ProfileStateWriterInitialization } from './profile-state-writer-protocol'
import type {
  SurfaceStorageCommand,
  SurfaceStorageMutation,
  SurfaceStorageResult
} from '../../../shared/workspace-surfaces/surface-storage-command'
import {
  executeSurfaceOwnerCommand,
  executeSurfaceOwnerCommands
} from '../../workspace-surfaces/surface-owner-command'

/** Reuse one writable handle; fenced domain commits preserve unchanged normalized rows. */
export class ProfileStateSqliteAuthority implements ProfileStateAuthority {
  private retired = false
  private observedRevision: number | undefined
  private writableDatabase: ReturnType<typeof openWritableProfileStateDatabase> | undefined
  private backupRotation: ProfileStateBackupRotation | undefined

  constructor(
    private readonly databasePath: string,
    private readonly profileId: string
  ) {}

  get surfaceExecutionScope() {
    this.assertActive()
    return { databasePath: this.databasePath, profileId: this.profileId }
  }

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

  /** Bind startup payload and write fence to the same accepted revision. */
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
      // Fence absence at revision zero against a concurrent creator.
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
    this.observeCurrentRevision()
    const opened = this.openWritableDatabase()
    this.observedRevision = writeProfileStateDomains(opened.db, {
      expectedRevision: this.observedRevision ?? 0,
      replacements,
      automationRunsAfter
    }).revision
  }

  executeSurfaceCommand(command: SurfaceStorageCommand): SurfaceStorageResult {
    return this.surfaceWrite((db, revision) => executeSurfaceOwnerCommand(db, revision, command))
      .result
  }

  executeSurfaceTransaction(commands: readonly SurfaceStorageMutation[]): SurfaceStorageResult[] {
    return this.surfaceWrite((db, revision) => executeSurfaceOwnerCommands(db, revision, commands))
      .results
  }

  executeSurfaceJointTransaction(transaction: SurfaceJointTransaction): SurfaceStorageResult[] {
    return this.surfaceWrite((db, revision) =>
      executeSurfaceJointTransaction(db, revision, transaction)
    ).results
  }

  executeSurfaceJournalUnit(
    transaction: SurfaceJointTransaction,
    effects: readonly JournalPersistenceEffect[]
  ) {
    const result = this.surfaceWrite((db, revision) =>
      executeSurfaceJointTransaction(
        db,
        revision,
        { ...transaction, effectCount: effects.length },
        effects
      )
    )
    return { surfaces: result.results, values: result.values }
  }

  private surfaceWrite<T extends { revision: number }>(
    write: (db: Database.Database, revision: number) => T
  ): T {
    this.observeCurrentRevision()
    const committed = write(this.openWritableDatabase().db, this.observedRevision ?? 0)
    this.observedRevision = committed.revision
    return committed
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
    this.writeCompleteSerializedDomains(serializedProfileDomainReplacements(payload))
  }

  writeCompleteSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]): void {
    this.observeCurrentRevision()
    this.observedRevision = writeCompleteProfileStateDomains(
      () => this.openWritableDatabase().db,
      this.observedRevision,
      replacements
    )
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
    return profileStateMaintenance(async () => {
      assertProfileStateRevisionOnDisk(this.databasePath, this.profileId, revision)
      this.assertCurrentRevision()
      this.backupRotation = undefined
    })
  }

  private createInitialState(
    revision: number,
    value: Record<string, unknown> | undefined
  ): ProfileStateAuthorityInitialState<ProfileStateSqliteAuthority> {
    this.observedRevision = revision
    return createProfileStateStartupTransfer(this, value, () => {
      this.assertActive()
      this.observedRevision = revision
    })
  }

  private observeCurrentRevision(): void {
    this.assertActive()
    if (this.observedRevision === undefined) {
      this.readSerializedState()
    }
  }

  private assertActive(): void {
    if (this.retired) {
      throw new Error('Profile state authority was retired for worker ownership')
    }
  }

  private openWritableDatabase(): NonNullable<ProfileStateSqliteAuthority['writableDatabase']> {
    this.assertActive()
    if (!this.writableDatabase) {
      const opened = openWritableProfileStateDatabase(this.databasePath, this.profileId)
      try {
        ensureProfileStateAuthorityMarker(this.databasePath)
        this.writableDatabase = opened
      } catch (error) {
        opened.db.close()
        throw error
      }
    }
    return this.writableDatabase
  }
}
