/**
 * Updating a managed orcad on connect, through the same update the Managed servers action runs.
 *
 * The connect only picks whether to try: the update planner still defers over live or uncounted
 * terminals, and a rejected candidate is restored through the activation journal, so the old
 * version keeps serving. A host a newer Orca activated is never downgraded.
 */
import {
  planManagedOrcadAutoUpdate,
  type ManagedOrcadAutoUpdateSkip
} from './orcad-managed-update-decision'
import { materializeOrcadArtifact } from '../../orcad/orcad-artifact-materializer'
import {
  OrcadArtifactsUnavailableError,
  OrcadHostUnsupportedError
} from '../../orcad/orcad-host-unavailable'
import { findIncompleteManagedOrcadMigration } from './orcad-managed-migration-status'
import { ORCAD_ACTIVATION_FENCE_BUSY_CODE } from '../activation/orcad-activation-fence-hold'
import { resolveLinkedOrcadContext } from './orcad-managed-runtime-context'
import {
  runManagedOrcadUpdate,
  withManagedOrcadLifecycle
} from '../../ssh/orcad-runtime-maintenance'
import type { OrcadUpdateDeferCode } from '../../ssh/orcad-update-plan'
import { readLocalFullVersion } from '../install/remote-versioned-install'

export type ManagedOrcadAutoUpdateOutcome =
  | { outcome: 'skipped'; reason: ManagedOrcadAutoUpdateSkip }
  | { outcome: 'updated'; activeVersion: string }
  /** The update planner chose to wait, e.g. for terminals to close; a later connect retries. */
  | { outcome: 'deferred'; code: string; reason: string }
  /** The candidate was rejected or the update threw; the incumbent keeps serving. */
  | { outcome: 'failed'; reason: string }

const WAITING_CODES: ReadonlySet<string> = new Set<
  OrcadUpdateDeferCode | typeof ORCAD_ACTIVATION_FENCE_BUSY_CODE
>([
  ORCAD_ACTIVATION_FENCE_BUSY_CODE,
  'orcad_update_terminals_running',
  'orcad_update_terminal_census_unavailable',
  'orcad_update_strands_live_terminals',
  'orcad_update_daemon_protocol_unverifiable',
  'orcad_update_ends_in_process_terminals'
])

/**
 * Deferrals that mean "not now", as opposed to a candidate that was tried and rejected. An
 * interrupted activation is not one: no later connect clears it, so it surfaces as a failure.
 */
export function isWaitingOrcadUpdateDeferral(code: string): boolean {
  return WAITING_CODES.has(code)
}

export function autoUpdateManagedOrcadEnvironment(
  userDataPath: string,
  args: {
    environmentId: string
    appVersion: string
    /** Read under the host's lifecycle lock, so overlapping checks see an earlier attempt's result. */
    failedBefore: () => boolean
    onUpdating: () => void
  }
): Promise<ManagedOrcadAutoUpdateOutcome> {
  return withManagedOrcadLifecycle(userDataPath, args.environmentId, async (managed) => {
    // Why: a restart mid-migration would race the staging the cutover journal is driving.
    if (findIncompleteManagedOrcadMigration(userDataPath, managed.environment.id)) {
      return { outcome: 'skipped', reason: 'migrating' }
    }
    const context = await resolveLinkedOrcadContext(managed.environment, managed.deployment)
    const candidateVersion = await bundledOrcadVersion(context.serverTarget)
    const plan = planManagedOrcadAutoUpdate({
      record: context.activationRecord,
      candidateVersion,
      appVersion: args.appVersion,
      failedBefore: args.failedBefore()
    })
    if (plan.action === 'skip') {
      return { outcome: 'skipped', reason: plan.reason }
    }
    args.onUpdating()
    let lockedSkip: ManagedOrcadAutoUpdateSkip | null = null
    try {
      const result = await runManagedOrcadUpdate(userDataPath, managed, context, {
        // Why again under the fence: another desktop may activate or stop a newer build mid-upload.
        admitRecord: (record) => {
          const locked = planManagedOrcadAutoUpdate({
            record,
            candidateVersion,
            appVersion: args.appVersion,
            failedBefore: false
          })
          if (locked.action === 'update') {
            return null
          }
          lockedSkip = locked.reason
          return `Auto-update skipped under the host fence: ${locked.reason}.`
        }
      })
      if (lockedSkip) {
        return { outcome: 'skipped', reason: lockedSkip }
      }
      if (result.outcome !== 'deferred') {
        return { outcome: 'updated', activeVersion: result.activeVersion }
      }
      return isWaitingOrcadUpdateDeferral(result.code)
        ? { outcome: 'deferred', code: result.code, reason: result.reason }
        : { outcome: 'failed', reason: result.reason }
    } catch (error) {
      return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  })
}

type OrcadTarget = Parameters<typeof materializeOrcadArtifact>[0]

// Why per session: the packaged template can't change while the app runs, and hashing it costs a read.
const bundledVersions = new Map<OrcadTarget, Promise<string | null>>()

function bundledOrcadVersion(target: OrcadTarget): Promise<string | null> {
  let version = bundledVersions.get(target)
  if (!version) {
    version = materializeOrcadArtifact(target).then(readLocalFullVersion, (error: unknown) => {
      if (
        error instanceof OrcadHostUnsupportedError ||
        error instanceof OrcadArtifactsUnavailableError
      ) {
        return null
      }
      throw error
    })
    // A transient local failure must not stick for the session.
    version.catch(() => bundledVersions.delete(target))
    bundledVersions.set(target, version)
  }
  return version
}

export function resetBundledOrcadVersionsForTests(): void {
  bundledVersions.clear()
}
