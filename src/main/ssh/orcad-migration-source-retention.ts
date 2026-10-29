/** Keep source rows for downgraded clients using their old relays; new clients hide them and serve managed state. Never delete retained rows automatically. */
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { Store } from '../persistence'
import { withRenamedOrcadMigrationDrafts } from '../persistence/migrating-orcad-catalog/orcad-source-draft-rename'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'

type OrcadMigrationDraftRenameStore = Pick<
  Store,
  | 'collectOrcadMigrationSourceDrafts'
  | 'disableAutomations'
  | 'getWorkspaceSession'
  | 'listAutomations'
  | 'runDurableMutation'
  | 'setWorkspaceSession'
>

// Serialize retains per migration so waiting callers observe completion.
const retainsInFlight = new Map<string, Promise<OrcadMigrationSourceCutover>>()

/** Durably rename unsaved drafts into the server partition before marking source retained, so the mark proves rename completion. */
export function retainOrcadMigrationSource(
  userDataPath: string,
  migrationId: string,
  store: OrcadMigrationDraftRenameStore,
  now: () => Date = () => new Date()
): Promise<OrcadMigrationSourceCutover> {
  const pending = retainsInFlight.get(migrationId)
  if (pending) {
    return pending
  }
  const retain = retainOnce(userDataPath, migrationId, store, now).finally(() =>
    retainsInFlight.delete(migrationId)
  )
  retainsInFlight.set(migrationId, retain)
  return retain
}

async function retainOnce(
  userDataPath: string,
  migrationId: string,
  store: OrcadMigrationDraftRenameStore,
  now: () => Date
): Promise<OrcadMigrationSourceCutover> {
  const cutover = readCommittedCutover(userDataPath, migrationId)
  if (cutover.sourceRetainedAt) {
    return cutover
  }
  const moved = new Set(cutover.manifest.payload.dormantState?.automations?.map(({ id }) => id))
  // Journal first: once the copies are disabled, nothing else records which ones ran here.
  const enabled = store
    .listAutomations()
    .filter((automation) => automation.enabled && moved.has(automation.id))
  if (cutover.automationsToEnableOnServer === undefined && enabled.length > 0) {
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...cutover,
      automationsToEnableOnServer: enabled.map(({ id }) => id)
    })
  }
  await store.runDurableMutation(() => {
    // A downgraded desktop would otherwise run the retained copy alongside the server.
    store.disableAutomations(moved)
    const renamed = renamedDestinationSession(store, cutover)
    if (!renamed) {
      // Startup rename may still be in memory; flush before recording retained completion.
      return { value: undefined, persist: 'if-dirty' }
    }
    // Renamed rows remain correct after failure; idempotent retry needs no rollback.
    writeDestinationSession(store, cutover, renamed.next)
    return { value: undefined }
  })
  // Only the pre-commit baseline proves destination state; an older build may have changed source after commit.
  const retained = {
    ...readCommittedCutover(userDataPath, migrationId),
    sourceRetainedAt: now().toISOString()
  }
  writeOrcadMigrationSourceCutover(userDataPath, retained)
  return retained
}

/** Rename committed drafts before any renderer loads sessions or it could overwrite them. Mark retained once so later startup never resurrects closed drafts. */
export function retainUnretainedOrcadMigrationSources(
  userDataPath: string,
  store: OrcadMigrationDraftRenameStore & Pick<Store, 'getSshTarget'>
): Promise<void> {
  const migrationIds: string[] = []
  try {
    for (const cutover of listOrcadMigrationSourceCutovers(userDataPath)) {
      // Shared journals do not authorize another profile to rename sessions.
      const target = store.getSshTarget(cutover.sshTargetId)
      if (
        cutover.phase !== 'destination-committed' ||
        cutover.sourceRetainedAt ||
        target?.generation !== cutover.sshTargetGeneration
      ) {
        continue
      }
      const renamed = renamedDestinationSession(store, cutover)
      if (renamed) {
        writeDestinationSession(store, cutover, renamed.next)
      }
      migrationIds.push(cutover.migrationId)
    }
  } catch (error) {
    // An unreadable journal must not fail startup; connect can retry the rename.
    console.warn('[ssh] Could not rename committed migrations’ unsaved drafts:', error)
  }
  return Promise.all(
    migrationIds.map((migrationId) =>
      retainOrcadMigrationSource(userDataPath, migrationId, store).catch((error: unknown) => {
        console.warn('[ssh] Could not mark a finished migration retained:', error)
      })
    )
  ).then(() => undefined)
}

function readCommittedCutover(userDataPath: string, migrationId: string) {
  const cutover = listOrcadMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover || cutover.phase !== 'destination-committed') {
    throw new Error('orcad_migration_retain_before_commit')
  }
  return cutover
}

/** Add only files absent from the destination partition so startup/connect retains remain idempotent. */
function renamedDestinationSession(
  store: Pick<
    OrcadMigrationDraftRenameStore,
    'collectOrcadMigrationSourceDrafts' | 'getWorkspaceSession'
  >,
  cutover: OrcadMigrationSourceCutover
): { next: WorkspaceSessionState } | null {
  const before = store.getWorkspaceSession(
    toRuntimeExecutionHostId(cutover.destinationEnvironmentId)
  )
  const next = withRenamedOrcadMigrationDrafts(
    before,
    store.collectOrcadMigrationSourceDrafts(cutover.manifest),
    cutover.destinationEnvironmentId
  )
  return next ? { next } : null
}

function writeDestinationSession(
  store: Pick<OrcadMigrationDraftRenameStore, 'setWorkspaceSession'>,
  cutover: OrcadMigrationSourceCutover,
  session: WorkspaceSessionState
): void {
  // Drafts are desktop view state absent from layout commands; manifest transfer alone carries their tabs.
  store.setWorkspaceSession(session, toRuntimeExecutionHostId(cutover.destinationEnvironmentId))
}
