import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { testState, createStore, readDataFile } from './persistence-test-harness'

// Stub the ~/.ssh/config parser so the real Store boots with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('open-with recent applications', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('records launches most-recent-first, dedupes to front, caps at 5, lowercases the key', () => {
    const store = createStore()

    store.recordOpenWithApplicationLaunch('.MD', 'app-a')
    store.recordOpenWithApplicationLaunch('.md', 'app-b')
    store.recordOpenWithApplicationLaunch('.md', 'app-a')
    expect(store.getOpenWithRecentApplicationIds('.md')).toEqual(['app-a', 'app-b'])

    for (const id of ['app-c', 'app-d', 'app-e', 'app-f']) {
      store.recordOpenWithApplicationLaunch('.md', id)
    }
    expect(store.getOpenWithRecentApplicationIds('.MD')).toEqual([
      'app-f',
      'app-e',
      'app-d',
      'app-c',
      'app-a'
    ])

    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.openWithRecentApplicationsByExtension).toEqual({
      '.md': ['app-f', 'app-e', 'app-d', 'app-c', 'app-a']
    })

    // Why: the field has no default in getDefaultPersistedState, so the load path must keep it.
    const reloaded = createStore()
    expect(reloaded.getOpenWithRecentApplicationIds('.md')).toEqual([
      'app-f',
      'app-e',
      'app-d',
      'app-c',
      'app-a'
    ])
  })

  it('ignores empty extensions and records nothing after writes freeze', () => {
    const store = createStore()

    store.recordOpenWithApplicationLaunch('  ', 'app-a')
    expect(store.getOpenWithRecentApplicationIds('')).toEqual([])

    store.freezeWrites()
    store.recordOpenWithApplicationLaunch('.md', 'app-a')
    expect(store.getOpenWithRecentApplicationIds('.md')).toEqual([])
  })
})
