import { randomUUID } from 'node:crypto'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { collectFolderWorkspaceDiffComments } from '../../folder-workspace-diff-comments'
import {
  PROTECTED_SECRET_SLOT,
  sshPtyOwnerLeaseSecretSlot,
  type ProtectedSecretRetentionUpdate
} from '../../protected-secret-persistence'
import { stripRetiredGlobalSettings } from '../applying-settings/terminal-settings-migrations'
import { omitDefaultWorktreeMetaFieldsInMap } from '../../../shared/worktree/meta-persisted-defaults'
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

  buildStateToSave(): {
    payload: Buffer
    stateHash: string
    protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  } {
    // Why sentinels (not a blob/key string match): the substitution must be
    // position-exact. A plain search for the ciphertext — or even for a
    // `"key":"blob"` token — can be mimicked by user-controlled state (e.g. an
    // agentDefaultEnv var named after a secret field, or a value equal to a
    // ciphertext), which would substitute the wrong site and let two DISTINCT
    // states normalize equal → a silently dropped write (data loss), reachable
    // on deterministic-IV platforms (macOS/legacy-Linux OSCrypt). A per-slot
    // random UUID can't occur anywhere else in the serialized state (the user
    // sets their data before it is minted), so it appears exactly once.
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
      // Values already identical in payload and hash need no sentinel substitution.
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
    // Why: clone before encrypting secrets so in-memory this.state stays plaintext.
    const stateToSave = {
      ...this.getDurableState(),
      // Default-valued metadata slots are re-filled at load (normalizeWorktreeLinkedItemMetadata),
      // so omitting them here is lossless and drops ~12% of the file on a heavy install.
      worktreeMeta: omitDefaultWorktreeMetaFieldsInMap(this.runtime.state.worktreeMeta),
      ...(this.runtime.state.worktreeMetaByIdentity !== undefined
        ? {
            worktreeMetaByIdentity: omitDefaultWorktreeMetaFieldsInMap(
              this.runtime.state.worktreeMetaByIdentity
            )
          }
        : {}),
      // 'local' owns these globals and is the only slice any read takes them from; the load path
      // re-seeds each partition's default, so writing them per host is pure file weight.
      ...(this.runtime.state.workspaceSessionsByHostId !== undefined
        ? {
            workspaceSessionsByHostId: withoutRedundantPartitionGlobals(
              this.runtime.state.workspaceSessionsByHostId,
              this.runtime.state.workspaceSession
            )
          }
        : {}),
      // Why both keys unconditionally: the explicit keys always win over the spread, and
      // JSON.stringify drops the `undefined` value so a note-free profile gains no key on disk.
      // The strip builds a new array here only; this.state records keep their notes in memory.
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
      settings: {
        ...stripRetiredGlobalSettings(this.runtime.state.settings),
        opencodeSessionCookie: encryptToSentinel(
          PROTECTED_SECRET_SLOT.opencodeSessionCookie,
          this.runtime.state.settings.opencodeSessionCookie
        ),
        httpProxyUrl: encryptToSentinel(
          PROTECTED_SECRET_SLOT.httpProxyUrl,
          this.runtime.state.settings.httpProxyUrl ?? ''
        )
      },
      ui: {
        ...this.runtime.state.ui,
        browserKagiSessionLink: encryptOptionalToSentinel(
          PROTECTED_SECRET_SLOT.browserKagiSessionLink,
          this.runtime.state.ui.browserKagiSessionLink
        )
      }
    }
    // Why compact: ~20% fewer bytes and less serialize time; all readers JSON.parse so formatting is irrelevant.
    // One full-state stringify; secret slots currently hold sentinels.
    const serialized = JSON.stringify(stateToSave)
    // Substitute each unique sentinel: ciphertext for the on-disk payload, a stable normalized
    // value for the guard hash. One pass builds both, so the multi-MB state is never copied per
    // sentinel and never encoded twice.
    const { payload, stateHash } = applySecretSentinelSubstitutions(
      serialized,
      secretSubs,
      protectedStorageDegraded ? 'safeStorage-degraded\0' : ''
    )
    return { payload, stateHash, protectedSecretUpdates }
  }
}
