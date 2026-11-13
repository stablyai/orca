import {
  serializeCompleteProfileStateDomains,
  serializeSelectiveProfileStateDomains
} from './profile-state-authority-writes'
import type { ProfileStateDomainReplacement } from './profile-state-authority'
import { randomUUID } from 'node:crypto'
import type { PersistedState } from '../../../../shared/persisted-state-types'
import { collectFolderWorkspaceDiffComments } from '../../../workspaces/catalog/folder-workspace-diff-comments'
import {
  PROTECTED_SECRET_SLOT,
  sshPtyOwnerLeaseSecretSlot,
  type ProtectedSecretRetentionUpdate
} from '../../../credentials/protected-secret-persistence'
import { stripRetiredGlobalSettings } from '../../applying-settings/terminal-settings-migrations'
import { LEGACY_OPENCODE_GO_API_KEY_SLOT } from '../profile-loading/legacy-opencode-go-api-key-migration'
import { omitDefaultWorktreeMetaFieldsInMap } from '../../../../shared/worktree/metadata/meta-persisted-defaults'
import { projectWorktreeMetaByIdentityOntoLocators } from '../worktree-metadata/worktree-meta-alias-projection'
import { withoutRedundantPartitionGlobals } from '../../../../shared/workspace-session/workspace-session-host-field-ownership'
import { WORKTREE_METADATA_DOMAINS } from '../../profile-save-domains'

import {
  applySecretSentinelSubstitutions,
  type SecretSentinelSubstitution
} from './secret-sentinel-substitution'
import type { StoreRuntimeState } from '../store-runtime-state'

/** Domains whose saved form differs from state; whole saves keep this order after the durable spread. */
const PROJECTED_SAVE_DOMAINS = [
  'worktreeMeta',
  'worktreeMetaByIdentity',
  'workspaceSessionsByHostId',
  'folderWorkspaces',
  'folderWorkspaceDiffComments',
  'sshPtyConsumerRecoveries',
  'settings',
  'ui'
] as const

/** Saved domains derived from another domain's state must be written with it. */
const DEPENDENT_SAVE_DOMAINS = new Map<string, readonly string[]>([
  ['folderWorkspaces', ['folderWorkspaceDiffComments']],
  ...WORKTREE_METADATA_DOMAINS.map((domain): [string, readonly string[]] => [
    domain,
    WORKTREE_METADATA_DOMAINS
  ])
])

function withDependentSaveDomains(domains: ReadonlySet<string>): ReadonlySet<string> {
  const saved = new Set<string>()
  for (const domain of domains) {
    // Memory-only state never reaches disk.
    if (domain === 'githubCache') {
      continue
    }
    saved.add(domain)
    for (const dependent of DEPENDENT_SAVE_DOMAINS.get(domain) ?? []) {
      saved.add(dependent)
    }
  }
  return saved
}

type StateSerializationSecretHandlingOperationsRuntime = Pick<
  StoreRuntimeState,
  'protectedSecrets' | 'state' | 'originalExperimentalNativeChat'
>

export class StateSerializationSecretHandlingOperations {
  constructor(private readonly runtime: StateSerializationSecretHandlingOperationsRuntime) {}

  getDurableState(): Omit<PersistedState, 'githubCache'> {
    const { githubCache: _memoryOnly, ...durable } = this.runtime.state
    return durable
  }

  /** Pending encryption requires full serialization so secret retention stays complete. */
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
    const protectedSecretUpdates: ProtectedSecretRetentionUpdate[] = []
    const encrypt = (slot: string, plaintext: string): string => {
      const encrypted = this.runtime.protectedSecrets.encrypt(slot, plaintext)
      if (encrypted.retentionUpdate) {
        protectedSecretUpdates.push(encrypted.retentionUpdate)
      }
      return encrypted.blob
    }
    const saved = withDependentSaveDomains(domains)
    const stateToSave: Record<string, unknown> = {}
    for (const domain of saved) {
      stateToSave[domain] = this.projectDomainToSave(domain, encrypt)
    }
    return {
      replacements: serializeSelectiveProfileStateDomains(stateToSave, saved),
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
    // Clone before encryption to keep in-memory state plaintext.
    const stateToSave: Record<string, unknown> = { ...this.getDurableState() }
    for (const domain of PROJECTED_SAVE_DOMAINS) {
      stateToSave[domain] = this.projectDomainToSave(domain, encryptToSentinel)
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

  /** The one saved form of each domain, shared by selective and whole saves. */
  private projectDomainToSave(
    domain: string,
    encrypt: (slot: string, plaintext: string) => string
  ): unknown {
    const { state } = this.runtime
    switch (domain) {
      case 'githubCache':
        return undefined
      case 'settings':
        return this.buildSettingsToSave(encrypt)
      case 'ui':
        return {
          ...state.ui,
          browserKagiSessionLink:
            encrypt(
              PROTECTED_SECRET_SLOT.browserKagiSessionLink,
              state.ui.browserKagiSessionLink ?? ''
            ) || null
        }
      // Load normalization restores omitted default metadata fields.
      case 'worktreeMeta':
        return omitDefaultWorktreeMetaFieldsInMap(state.worktreeMeta)
      // Project shared aliases before default omission clones rows, avoiding per-row deep comparisons.
      case 'worktreeMetaByIdentity':
        return state.worktreeMetaByIdentity === undefined
          ? undefined
          : omitDefaultWorktreeMetaFieldsInMap(
              projectWorktreeMetaByIdentityOntoLocators(state.worktreeMetaByIdentity, state)
            )
      // Local owns these globals; host partitions restore defaults on load.
      case 'workspaceSessionsByHostId':
        return state.workspaceSessionsByHostId === undefined
          ? undefined
          : withoutRedundantPartitionGlobals(
              state.workspaceSessionsByHostId,
              state.workspaceSession
            )
      // Relocate notes without mutating in-memory workspace rows; undefined omits the map when none exist.
      case 'folderWorkspaces':
        return (state.folderWorkspaces ?? []).map(({ diffComments: _relocated, ...rest }) => rest)
      case 'folderWorkspaceDiffComments':
        return collectFolderWorkspaceDiffComments(state.folderWorkspaces)
      case 'sshPtyConsumerRecoveries':
        return (state.sshPtyConsumerRecoveries ?? []).map((record) => ({
          ...record,
          ownerLease: encrypt(sshPtyOwnerLeaseSecretSlot(record.targetId), record.ownerLease)
        }))
      default:
        // Own properties only, including domains this build doesn't know.
        return Object.getOwnPropertyDescriptor(state, domain)?.value
    }
  }

  private buildSettingsToSave(encrypt: (slot: string, plaintext: string) => string) {
    return {
      ...stripRetiredGlobalSettings(this.runtime.state.settings),
      ...this.runtime.originalExperimentalNativeChat,
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
