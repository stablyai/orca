import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { normalizeProxyUrl } from '../../../shared/network-proxy'
import { normalizeKagiSessionLink } from '../../../shared/browser-url'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshPtyConsumerRecovery } from '../../../shared/ssh-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session-browser-history'
import { clearMissingProjectGroupMemberships } from '../../../shared/project-groups'
import { migrateWorkspaceSessionTerminalScrollbackSnapshots } from '../../terminal-scrollback-snapshots'
import {
  isStartupDiagnosticsEnabled,
  logStartupDiagnostic
} from '../../startup/startup-diagnostics'
import {
  PROTECTED_SECRET_SLOT,
  sshPtyOwnerLeaseSecretSlot
} from '../../protected-secret-persistence'
import {
  isLegacyOpenCodeSessionCookie,
  isLegacySshPtyOwnerLease
} from '../leasing-ssh-ptys/secret-validation'
import { readGithubCacheSnapshot } from './user-data-path'
import {
  gcStaleWorktreeMeta,
  normalizeWorktreeLinkedItemMetadata
} from '../tracking-repos/worktree-metadata-normalization'
import { backfillLegacyAutomationContexts } from '../scheduling-automations/automation-context-migration'
import {
  ENCRYPTED_SSH_PTY_OWNER_LEASE_MAX_LENGTH,
  normalizeSshPtyConsumerRecovery
} from '../leasing-ssh-ptys/ssh-normalization'
import {
  mergeProjectHostSetupCompatibilityState,
  projectHostSetupCompatibilityStateEqual
} from '../tracking-repos/project-host-compatibility'
import { backfillFolderScopeConnectionIds } from '../restoring-sessions/folder-scope-migration'
import { hasStateBackup } from './backup-recovery-rotation'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import { normalizeLoadedProfileState } from './normalize-loaded-profile-state'

function logPersistenceStartupMilestone(
  event: string,
  details: Record<string, unknown> = {}
): void {
  if (isStartupDiagnosticsEnabled()) {
    logStartupDiagnostic(event, { t: Math.round(performance.now()), ...details })
  }
}

import type { StoreRuntimeState } from './store-runtime-state'
import type { BackupRecoveryRotationOperations } from './backup-recovery-rotation'
import type { LoadedCohortMigrationOperations } from './loaded-cohort-migrations'

type LoadedStateParsingOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'dataFile'
  | 'githubCacheDirty'
  | 'loadNeedsSave'
  | 'protectedSecrets'
  | 'terminalScrollbackSnapshotStorage'
>

export class LoadedStateParsingOperations {
  constructor(
    private readonly runtime: LoadedStateParsingOperationsRuntime,
    private readonly backups: BackupRecoveryRotationOperations,
    private readonly cohorts: LoadedCohortMigrationOperations
  ) {}

  load(allowBackupRecovery = true): PersistedState {
    // Capture "has run Orca before?" for telemetry cohort; the telemetry field is new, so field inference misclassifies old users as fresh.
    const dataFile = this.runtime.dataFile
    const fileExistedOnLoad = existsSync(dataFile)
    logPersistenceStartupMilestone('persistence-load-start', {
      fileExists: fileExistedOnLoad
    })

    let result: PersistedState | null = null
    try {
      if (fileExistedOnLoad) {
        const readStartedAt = performance.now()
        const raw = readFileSync(dataFile, 'utf-8')
        logPersistenceStartupMilestone('persistence-read-done', {
          bytes: Buffer.byteLength(raw),
          durationMs: Math.round(performance.now() - readStartedAt)
        })
        logPersistenceStartupMilestone('persistence-json-parse-start')
        const parsed = JSON.parse(raw) as PersistedState
        logPersistenceStartupMilestone('persistence-json-parse-done')

        // Why: secrets are stored encrypted via safeStorage; decrypt at the load boundary so the app sees plaintext.
        if (parsed.settings?.opencodeSessionCookie) {
          parsed.settings.opencodeSessionCookie = this.runtime.protectedSecrets.decrypt(
            PROTECTED_SECRET_SLOT.opencodeSessionCookie,
            parsed.settings.opencodeSessionCookie,
            isLegacyOpenCodeSessionCookie
          )
        }
        if (parsed.settings?.httpProxyUrl) {
          const decryptedProxy = this.runtime.protectedSecrets.decryptWithStatus(
            PROTECTED_SECRET_SLOT.httpProxyUrl,
            parsed.settings.httpProxyUrl,
            (value) => normalizeProxyUrl(value).ok
          )
          // Why (STA-3442): after a keychain reset decrypt returns raw ciphertext; a non-URL
          // value must not masquerade as a configured proxy (silent DIRECT fallback) or
          // re-persist as garbage. Plaintext URLs still pass, preserving the upgrade path.
          if (
            decryptedProxy.status === 'unavailable' ||
            (decryptedProxy.status === 'failed' && !decryptedProxy.plaintext)
          ) {
            parsed.settings.httpProxyUrl = ''
          } else if (normalizeProxyUrl(decryptedProxy.plaintext).ok) {
            parsed.settings.httpProxyUrl = decryptedProxy.plaintext
          } else {
            console.warn(
              '[persistence] httpProxyUrl could not be decrypted — clearing the stored proxy URL. Re-enter it in Settings > Advanced > Network.'
            )
            parsed.settings.httpProxyUrl = ''
            this.runtime.protectedSecrets.removeRetainedBlob(PROTECTED_SECRET_SLOT.httpProxyUrl)
            this.runtime.loadNeedsSave = true
          }
        }
        if (parsed.ui?.browserKagiSessionLink) {
          parsed.ui.browserKagiSessionLink = this.runtime.protectedSecrets.decrypt(
            PROTECTED_SECRET_SLOT.browserKagiSessionLink,
            parsed.ui.browserKagiSessionLink,
            (value) => normalizeKagiSessionLink(value) !== null
          )
        }
        parsed.sshPtyConsumerRecoveries = (
          Array.isArray(parsed.sshPtyConsumerRecoveries) ? parsed.sshPtyConsumerRecoveries : []
        )
          .map((record) =>
            normalizeSshPtyConsumerRecovery(record, ENCRYPTED_SSH_PTY_OWNER_LEASE_MAX_LENGTH)
          )
          .filter((record): record is SshPtyConsumerRecovery => record !== null)
          .map((record) => {
            const slot = sshPtyOwnerLeaseSecretSlot(record.targetId)
            const decrypted = this.runtime.protectedSecrets.decryptWithStatus(
              slot,
              record.ownerLease,
              isLegacySshPtyOwnerLease
            )
            const normalized =
              decrypted.status === 'unavailable' ||
              (decrypted.status === 'failed' && !decrypted.plaintext)
                ? record
                : normalizeSshPtyConsumerRecovery({ ...record, ownerLease: decrypted.plaintext })
            if (!normalized) {
              this.runtime.protectedSecrets.removeRetainedBlob(slot)
            }
            return normalized
          })
          .filter((record): record is SshPtyConsumerRecovery => record !== null)

        const terminalSettings = prepareLoadedTerminalSettings(parsed, () => {
          this.runtime.loadNeedsSave = true
        })
        const profileSettings = prepareLoadedProfileSettings(
          parsed,
          terminalSettings.defaults,
          () => {
            this.runtime.loadNeedsSave = true
          }
        )
        result = normalizeLoadedProfileState(parsed, terminalSettings, profileSettings, () => {
          this.runtime.loadNeedsSave = true
        })
      }
    } catch (err) {
      console.error('[persistence] Failed to load primary state, trying backups:', err)
    }

    // Corrupt-file and no-file paths converge here; a corrupted install counts as existing, so it sees the opt-in banner.
    if (result === null && allowBackupRecovery) {
      const hasBackup = hasStateBackup(dataFile)
      if (fileExistedOnLoad || hasBackup) {
        if (this.backups.restoreFromBackup(dataFile)) {
          return this.load(false)
        }
        console.error('[persistence] No usable state file or backup found, using defaults')
      }
    }

    if (result === null) {
      result = getDefaultPersistedState(homedir())
    }

    const workspaceSession = pruneWorkspaceSessionBrowserHistory(
      pruneLocalTerminalScrollbackBuffers(result.workspaceSession, result.repos)
    )
    const migratedScrollback = migrateWorkspaceSessionTerminalScrollbackSnapshots(
      workspaceSession,
      this.runtime.terminalScrollbackSnapshotStorage
    )
    if (migratedScrollback.changed) {
      this.runtime.loadNeedsSave = true
    }

    const repos = clearMissingProjectGroupMemberships(result.repos, result.projectGroups ?? [])
    const projectHostSetupCompatibility = mergeProjectHostSetupCompatibilityState(result, repos)
    if (!projectHostSetupCompatibilityStateEqual(result, projectHostSetupCompatibility)) {
      this.runtime.loadNeedsSave = true
    }

    const automationContextMigration = backfillLegacyAutomationContexts({
      ...result,
      repos,
      ...projectHostSetupCompatibility
    })
    if (automationContextMigration.changed) {
      this.runtime.loadNeedsSave = true
    }
    result = {
      ...result,
      automations: automationContextMigration.state.automations,
      automationRuns: automationContextMigration.state.automationRuns
    }

    const folderScopeConnectionMigration = backfillFolderScopeConnectionIds({
      ...result,
      repos,
      ...projectHostSetupCompatibility,
      workspaceSession: migratedScrollback.session
    })
    if (folderScopeConnectionMigration.changed) {
      this.runtime.loadNeedsSave = true
    }
    result = folderScopeConnectionMigration.state

    if (normalizeWorktreeLinkedItemMetadata(result)) {
      this.runtime.loadNeedsSave = true
    }

    if (gcStaleWorktreeMeta(result) > 0) {
      this.runtime.loadNeedsSave = true
    }

    const migrated = this.cohorts.migrateTabSwitchKeybindings(
      this.cohorts.migrateTelemetry(result, fileExistedOnLoad),
      fileExistedOnLoad
    )

    // githubCache is a sidecar file now (see getGithubCacheFile); legacy in-file caches seed the session, then get stripped.
    const legacyCache = migrated.githubCache
    const hasLegacyCache =
      Object.keys(legacyCache?.pr ?? {}).length > 0 ||
      Object.keys(legacyCache?.issue ?? {}).length > 0
    if (hasLegacyCache) {
      this.runtime.loadNeedsSave = true
      // Why: mark dirty so the first flush writes the sidecar even without a poll refresh this session, preserving the seed.
      this.runtime.githubCacheDirty = true
    } else {
      migrated.githubCache = readGithubCacheSnapshot(this.runtime.dataFile) ?? migrated.githubCache
    }

    logPersistenceStartupMilestone('persistence-load-done', {
      repos: migrated.repos.length,
      workspaceSessionBytes: Buffer.byteLength(JSON.stringify(migrated.workspaceSession))
    })
    return migrated
  }
}
