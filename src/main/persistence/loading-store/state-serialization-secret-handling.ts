import {
  serializeCompleteProfileStateDomains,
  serializeSelectiveProfileStateDomains
} from './profile-state-authority-writes'
import type { ProfileStateDomainReplacement } from './profile-state-authority'
import { randomUUID } from 'node:crypto'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { collectFolderWorkspaceDiffComments } from '../../folder-workspace-diff-comments'
import {
  PROTECTED_SECRET_SLOT,
  sshPtyOwnerLeaseSecretSlot,
  type ProtectedSecretRetentionUpdate
} from '../../protected-secret-persistence'
import { stripRetiredGlobalSettings } from '../applying-settings/terminal-settings-migrations'
import { LEGACY_OPENCODE_GO_API_KEY_SLOT } from './legacy-opencode-go-api-key-migration'
import { omitDefaultWorktreeMetaFieldsInMap } from '../../../shared/worktree/meta-persisted-defaults'
import { projectWorktreeMetaByIdentityOntoLocators } from './worktree-meta-alias-projection'
import { withoutRedundantPartitionGlobals } from '../../../shared/workspace-session-host-field-ownership'

import {
  applySecretSentinelSubstitutions,
  type SecretSentinelSubstitution
} from './secret-sentinel-substitution'
import type { StoreRuntimeState } from './store-runtime-state'

type StateSerializationSecretHandlingOperationsRuntime = Pick<
  StoreRuntimeState,
  'protectedSecrets' | 'state'
>

export class StateSerializationSecretHandlingOperations {
  constructor(private readonly runtime: StateSerializationSecretHandlingOperationsRuntime) {}

  getDurableState(): Omit<PersistedState, 'githubCache'> {
    const { githubCache: _memoryOnly, ...durable } = this.runtime.state
    return durable
  }

  /** Unknown domains require full serialization so secret retention stays complete. */
  buildStateDomainsToSave(domains: ReadonlySet<string>):
    | {
        replacements: ProfileStateDomainReplacement[]
        protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
      }
    | undefined {
    // Deferred secrets require retry until a durable commit accepts their encryption.
    if (this.runtime.protectedSecrets.hasPendingEncryption()) {
      return undefined
    }
    const stateToSave: Record<string, unknown> = {}
    const protectedSecretUpdates: ProtectedSecretRetentionUpdate[] = []
    const encrypt = (slot: string, plaintext: string): string => {
      const encrypted = this.runtime.protectedSecrets.encrypt(slot, plaintext)
      if (encrypted.retentionUpdate) {
        protectedSecretUpdates.push(encrypted.retentionUpdate)
      }
      return encrypted.blob
    }
    for (const domain of domains) {
      switch (domain) {
        case 'settings':
          stateToSave[domain] = this.buildSettingsToSave(encrypt)
          break
        case 'workspaceSession':
          stateToSave[domain] = this.runtime.state.workspaceSession
          break
        case 'automations':
        case 'automationRuns':
          stateToSave[domain] = this.runtime.state[domain]
          break
        case 'featureInteractionTelemetryBuckets':
          stateToSave[domain] = this.runtime.state.featureInteractionTelemetryBuckets
          break
        case 'ui':
          stateToSave[domain] = {
            ...this.runtime.state.ui,
            browserKagiSessionLink:
              encrypt(
                PROTECTED_SECRET_SLOT.browserKagiSessionLink,
                this.runtime.state.ui.browserKagiSessionLink ?? ''
              ) || null
          }
          break
        case 'worktreeMeta':
          stateToSave[domain] = omitDefaultWorktreeMetaFieldsInMap(this.runtime.state.worktreeMeta)
          break
        case 'worktreeMetaByIdentity':
          if (this.runtime.state.worktreeMetaByIdentity !== undefined) {
            stateToSave[domain] = omitDefaultWorktreeMetaFieldsInMap(
              projectWorktreeMetaByIdentityOntoLocators(
                this.runtime.state.worktreeMetaByIdentity,
                this.runtime.state
              )
            )
          }
          break
        case 'worktreeIdentityAliases':
          if (this.runtime.state.worktreeIdentityAliases !== undefined) {
            stateToSave[domain] = this.runtime.state.worktreeIdentityAliases
          }
          break
        case 'workspaceSessionsByHostId':
          if (this.runtime.state.workspaceSessionsByHostId !== undefined) {
            stateToSave[domain] = withoutRedundantPartitionGlobals(
              this.runtime.state.workspaceSessionsByHostId,
              this.runtime.state.workspaceSession
            )
          }
          break
        case 'sshRemotePtyLeases':
        case 'remoteLayoutSnapshots':
        case 'legacyPaneKeyAliasEntries':
        case 'migrationUnsupportedPtyEntries':
          stateToSave[domain] = this.runtime.state[domain]
          break
        default:
          return undefined
      }
    }
    return {
      replacements: serializeSelectiveProfileStateDomains(stateToSave, domains),
      protectedSecretUpdates
    }
  }

  buildStateToSave(serializeDomains = false): {
    domains?: readonly ProfileStateDomainReplacement[]
    payload: Buffer
    stateHash: string
    protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  } {
    // Mint slot UUIDs after user data is captured; ciphertext searches could match user data and hide real changes.
    const secretSubs: SecretSentinelSubstitution[] = []
    const protectedSecretUpdates: ProtectedSecretRetentionUpdate[] = []
    let protectedStorageDegraded = false
    const encryptToSentinel = (slot: string, plaintext: string): string => {
      const encrypted = this.runtime.protectedSecrets.encrypt(slot, plaintext)
      if (encrypted.retentionUpdate) {
        protectedSecretUpdates.push(encrypted.retentionUpdate)
      }
      protectedStorageDegraded ||= encrypted.degraded
      const { blob, hashValue = plaintext } = encrypted
      if (blob === plaintext && hashValue === plaintext) {
        return blob
      }
      const sentinel = `orca-secret-slot-${randomUUID()}`
      secretSubs.push({ sentinel, blob, hashValue })
      return sentinel
    }
    const encryptOptionalToSentinel = (
      slot: string,
      plaintext: string | null | undefined
    ): string | null => {
      const encrypted = encryptToSentinel(slot, plaintext ?? '')
      return encrypted || null
    }
    // Project shared aliases before default omission clones rows, avoiding per-row deep comparisons.
    const projectedWorktreeMetaByIdentity =
      this.runtime.state.worktreeMetaByIdentity === undefined
        ? undefined
        : projectWorktreeMetaByIdentityOntoLocators(
            this.runtime.state.worktreeMetaByIdentity,
            this.runtime.state
          )
    // Clone before encryption to keep in-memory state plaintext.
    const stateToSave = {
      ...this.getDurableState(),
      // Load normalization restores omitted default metadata fields.
      worktreeMeta: omitDefaultWorktreeMetaFieldsInMap(this.runtime.state.worktreeMeta),
      ...(projectedWorktreeMetaByIdentity !== undefined
        ? {
            worktreeMetaByIdentity: omitDefaultWorktreeMetaFieldsInMap(
              projectedWorktreeMetaByIdentity
            )
          }
        : {}),
      // Local owns these globals; host partitions restore defaults on load.
      ...(this.runtime.state.workspaceSessionsByHostId !== undefined
        ? {
            workspaceSessionsByHostId: withoutRedundantPartitionGlobals(
              this.runtime.state.workspaceSessionsByHostId,
              this.runtime.state.workspaceSession
            )
          }
        : {}),
      // Override both spread keys to relocate notes without mutating in-memory workspace rows.
      // Undefined omits the map entirely when no notes exist.
      folderWorkspaces: (this.runtime.state.folderWorkspaces ?? []).map(
        ({ diffComments: _relocated, ...rest }) => rest
      ),
      folderWorkspaceDiffComments: collectFolderWorkspaceDiffComments(
        this.runtime.state.folderWorkspaces
      ),
      sshPtyConsumerRecoveries: (this.runtime.state.sshPtyConsumerRecoveries ?? []).map(
        (record) => ({
          ...record,
          ownerLease: encryptToSentinel(
            sshPtyOwnerLeaseSecretSlot(record.targetId),
            record.ownerLease
          )
        })
      ),
      settings: this.buildSettingsToSave(encryptToSentinel),
      ui: {
        ...this.runtime.state.ui,
        browserKagiSessionLink: encryptOptionalToSentinel(
          PROTECTED_SECRET_SLOT.browserKagiSessionLink,
          this.runtime.state.ui.browserKagiSessionLink
        )
      }
    }
    if (
      serializeDomains &&
      !('toJSON' in stateToSave && typeof stateToSave.toJSON === 'function')
    ) {
      const serialized = serializeCompleteProfileStateDomains(
        stateToSave,
        secretSubs,
        protectedStorageDegraded ? 'safeStorage-degraded\0' : ''
      )
      return {
        domains: serialized.domains,
        stateHash: serialized.stateHash,
        get payload() {
          return serialized.payload
        },
        protectedSecretUpdates
      }
    }
    const serialized = JSON.stringify(stateToSave)
    // Build ciphertext and stable hashes in one pass, reusing literal UTF-8 segments.
    const { payload, stateHash } = applySecretSentinelSubstitutions(
      serialized,
      secretSubs,
      protectedStorageDegraded ? 'safeStorage-degraded\0' : ''
    )
    return { payload, stateHash, protectedSecretUpdates }
  }

  private buildSettingsToSave(encrypt: (slot: string, plaintext: string) => string) {
    return {
      ...stripRetiredGlobalSettings(this.runtime.state.settings),
      opencodeSessionCookie: encrypt(
        PROTECTED_SECRET_SLOT.opencodeSessionCookie,
        this.runtime.state.settings.opencodeSessionCookie
      ),
      ...(this.runtime.protectedSecrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)
        ? { opencodeGoApiKey: encrypt(LEGACY_OPENCODE_GO_API_KEY_SLOT, '') }
        : {}),
      httpProxyUrl: encrypt(
        PROTECTED_SECRET_SLOT.httpProxyUrl,
        this.runtime.state.settings.httpProxyUrl ?? ''
      )
    }
  }
}
