import { closeTestStores, testState, createStore } from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

describe('profile save serialization', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('saves every named domain exactly as a whole save does', async () => {
    const store = createStore()
    store.updateSettings({ httpProxyUrl: 'http://proxy.example:8080' })
    store.updateUI({ browserKagiSessionLink: 'https://kagi.example/session' })
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Refund fix' })
    store.updateFolderWorkspace(workspace.id, {
      diffComments: [
        {
          id: 'note-1',
          worktreeId: folderWorkspaceKey(workspace.id),
          filePath: 'README.md',
          source: 'markdown',
          lineNumber: 1,
          body: 'Review this',
          createdAt: 100,
          side: 'modified'
        }
      ]
    })
    store.setWorktreeMeta({ id: 'repo-1::/work/wt-1', hostId: 'local' }, { comment: 'pinned' })
    const runtime = Reflect.get(store, 'runtime')
    runtime.state.sshPtyConsumerRecoveries = [
      {
        targetId: 'ssh-1',
        clientInstanceId: 'client-1',
        serverBuildId: 'server-1',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'lease-secret'
      }
    ]
    const serialization: StateSerializationSecretHandlingOperations = Reflect.get(
      Reflect.get(store, 'domains'),
      'serialization'
    )

    const whole = serialization.buildStateToSave(true).domains!
    const named = serialization.buildStateDomainsToSave(new Set(whole.map(({ domain }) => domain)))

    expect(named).toBeDefined()
    expect(new Map(named!.replacements.map(({ domain, payload }) => [domain, payload]))).toEqual(
      new Map(whole.map(({ domain, payload }) => [domain, payload]))
    )
  })
})
