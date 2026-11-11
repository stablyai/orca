import { describe, it, expect, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { ProtectedSecretPersistence } from '../../credentials/protected-secret-persistence'
import { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

describe('profile save serialization', () => {
  it('saves every named domain exactly as a whole save does', () => {
    const state = getDefaultPersistedState('/home/user')
    state.settings.httpProxyUrl = 'http://proxy.example:8080'
    state.ui.browserKagiSessionLink = 'https://kagi.example/session'
    state.folderWorkspaces = [
      {
        id: 'fw-1',
        projectGroupId: 'group-1',
        name: 'Refund fix',
        folderPath: '/workspace/platform',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1,
        diffComments: [
          {
            id: 'note-1',
            worktreeId: folderWorkspaceKey('fw-1'),
            filePath: 'README.md',
            source: 'markdown',
            lineNumber: 1,
            body: 'Review this',
            createdAt: 100,
            side: 'modified'
          }
        ]
      }
    ]
    const row: WorktreeMeta = {
      instanceId: 'instance-1',
      hostId: 'local',
      displayName: 'wt-1',
      comment: 'pinned',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1
    }
    state.worktreeMeta = { 'repo-1::/work/wt-1': row }
    state.worktreeMetaByIdentity = { 'wt2:local:instance-1': row }
    state.worktreeIdentityAliases = { 'local::repo-1::/work/wt-1': ['wt2:local:instance-1'] }
    state.sshPtyConsumerRecoveries = [
      {
        targetId: 'ssh-1',
        clientInstanceId: 'client-1',
        serverBuildId: 'server-1',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'lease-secret'
      }
    ]
    const serialization = new StateSerializationSecretHandlingOperations({
      protectedSecrets: new ProtectedSecretPersistence(),
      state
    })

    const whole = serialization.buildStateToSave(true).domains!
    const named = serialization.buildStateDomainsToSave(new Set(whole.map(({ domain }) => domain)))

    expect(named).toBeDefined()
    expect(new Map(named!.replacements.map(({ domain, payload }) => [domain, payload]))).toEqual(
      new Map(whole.map(({ domain, payload }) => [domain, payload]))
    )
  })
})
