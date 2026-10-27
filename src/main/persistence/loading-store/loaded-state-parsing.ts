import { homedir } from 'node:os'
import { normalizeProxyUrl } from '../../../shared/network-proxy'
import { normalizeKagiSessionLink } from '../../../shared/browser-url'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { NativeChatUpgradeTipAudience } from '../../../shared/native-chat/native-chat-upgrade-tip-audience'
import type { SshPtyConsumerRecovery } from '../../../shared/ssh-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session-browser-history'
import { clearMissingProjectGroupMemberships } from '../../../shared/project-groups'
import { migrateWorkspaceSessionTerminalScrollbackSnapshots } from '../../terminal-scrollback-snapshots'
import { logStartupMilestone } from '../../startup/startup-diagnostics'
import {
  PROTECTED_SECRET_SLOT,
  sshPtyOwnerLeaseSecretSlot
} from '../../protected-secret-persistence'
import {
  isLegacyOpenCodeSessionCookie,
  isLegacySshPtyOwnerLease
} from '../leasing-ssh-ptys/secret-validation'
import { readGithubCacheSnapshot } from './user-data-path'
import { retainLegacyOpenCodeGoApiKey } from './legacy-opencode-go-api-key-migration'
import {
  gcStaleWorktreeMeta,
  normalizeWorktreeLinkedItemMetadata
} from '../tracking-repos/worktree-metadata-normalization'
import { backfillLegacyAutomationContexts } from '../scheduling-automations/automation-context-migration'
import { migrateAutomationOwners } from '../../automations/automation-owner-migration'
import {
  ENCRYPTED_SSH_PTY_OWNER_LEASE_MAX_LENGTH,
  normalizeSshPtyConsumerRecovery
} from '../leasing-ssh-ptys/ssh-normalization'
import {
  mergeProjectHostSetupCompatibilityState,
  projectHostSetupCompatibilityStateEqual
} from '../tracking-repos/project-host-compatibility'
import { backfillFolderScopeConnectionIds } from '../restoring-sessions/folder-scope-migration'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import { normalizeLoadedProfileState } from './normalize-loaded-profile-state'

import type { StoreRuntimeState } from './store-runtime-state'
import type { LoadedCohortMigrationOperations } from './loaded-cohort-migrations'

type LoadedStateParsingOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'dataFile'
  | 'githubCacheDirty'
  | 'loadNeedsSave'
  | 'protectedSecrets'
  | 'storageAuthority'
  | 'terminalScrollbackSnapshotStorage'
>

export class LoadedStateParsingOperations {
  constructor(
    private readonly runtime: LoadedStateParsingOperationsRuntime,
    private readonly cohorts: LoadedCohortMigrationOperations
  ) {}

  /** Imported documents use normal migration/decryption; invalid input must not fall back to unrelated disk state. */
  loadSerialized(raw: string): PersistedState {
    return this.loadInternal(raw)
  }

  loadFromAuthority(raw: string | undefined): PersistedState {
    return this.loadInternal(raw)
  }

  loadParsedFromAuthority(parsed: Record<string, unknown> | undefined): PersistedState {
    return this.loadInternal(undefined, parsed)
  }

  private loadInternal(serialized?: string, parsedInput?: Record<string, unknown>): PersistedState {
    // Pre-telemetry profiles lack cohort fields, so source existence determines upgrade status.
    const fileExistedOnLoad = serialized !== undefined || parsedInput !== undefined
    logStartupMilestone('persistence-load-start', {
      fileExists: fileExistedOnLoad
    })

    let result: PersistedState | null = null
    let parsed: PersistedState | undefined
    let nativeChatUpgradeTipAudience: NativeChatUpgradeTipAudience | null = null
    try {
      if (fileExistedOnLoad) {
        const readStartedAt = performance.now()
        const raw = parsedInput === undefined ? serialized : undefined
        if (raw !== undefined) {
          logStartupMilestone('persistence-read-done', {
            bytes: Buffer.byteLength(raw),
            durationMs: Math.round(performance.now() - readStartedAt)
          })
          logStartupMilestone('persistence-json-parse-start')
          parsed = JSON.parse(raw)
          logStartupMilestone('persistence-json-parse-done')
        } else {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Legacy partial records enter the existing domain normalizers through this loader type.
          parsed = parsedInput as PersistedState
        }
        if (parsed === undefined) {
          throw new Error('Profile state startup snapshot is missing')
        }
        // Freeze audience before defaults or migrations alter the saved Chat UI state.
        nativeChatUpgradeTipAudience = this.cohorts.captureNativeChatUpgradeTipAudience(parsed)
        if (parsed.settings?.opencodeSessionCookie) {
          parsed.settings.opencodeSessionCookie = this.runtime.protectedSecrets.decrypt(
            PROTECTED_SECRET_SLOT.opencodeSessionCookie,
            parsed.settings.opencodeSessionCookie,
            isLegacyOpenCodeSessionCookie
          )
        }
        retainLegacyOpenCodeGoApiKey(parsed.settings, this.runtime.protectedSecrets)
        if (parsed.settings?.httpProxyUrl) {
          const decryptedProxy = this.runtime.protectedSecrets.decryptWithStatus(
            PROTECTED_SECRET_SLOT.httpProxyUrl,
            parsed.settings.httpProxyUrl,
            (value) => normalizeProxyUrl(value).ok
          )
          // Preserve failed proxy ciphertext as inert data; only valid URLs may configure networking.
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
      console.error('[persistence] Failed to load imported profile state:', err)
      throw new Error('Failed to load imported profile state', { cause: err })
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

    const automationOwnerMigration = migrateAutomationOwners({
      automations: result.automations,
      sshTargets: result.sshTargets,
      repos,
      folderWorkspaces: result.folderWorkspaces,
      projectGroups: result.projectGroups,
      sshTargetGenerationCounter: result.sshTargetGenerationCounter,
      storageAuthority: this.runtime.storageAuthority
    })
    if (automationOwnerMigration.changed) {
      this.runtime.loadNeedsSave = true
    }
    result = {
      ...result,
      automations: automationOwnerMigration.automations,
      sshTargets: automationOwnerMigration.sshTargets,
      sshTargetGenerationCounter: automationOwnerMigration.sshTargetGenerationCounter
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

    const migrated = {
      ...this.cohorts.migrateTabSwitchKeybindings(
        this.cohorts.migrateTelemetry(result, fileExistedOnLoad),
        fileExistedOnLoad
      ),
      nativeChatUpgradeTipAudience:
        nativeChatUpgradeTipAudience ?? this.cohorts.captureNativeChatUpgradeTipAudience(undefined)
    }

    // Legacy inline caches seed the session, then move to the cache sidecar.
    const legacyCache = migrated.githubCache
    const hasLegacyCache =
      Object.keys(legacyCache?.pr ?? {}).length > 0 ||
      Object.keys(legacyCache?.issue ?? {}).length > 0
    if (hasLegacyCache) {
      this.runtime.loadNeedsSave = true
      // Persist the seed even when no cache poll refresh occurs this session.
      this.runtime.githubCacheDirty = true
    } else {
      migrated.githubCache = readGithubCacheSnapshot(this.runtime.dataFile) ?? migrated.githubCache
    }

    logStartupMilestone('persistence-load-done', () => ({
      repos: migrated.repos.length,
      workspaceSessionBytes: Buffer.byteLength(JSON.stringify(migrated.workspaceSession))
    }))
    return migrated
  }
}
