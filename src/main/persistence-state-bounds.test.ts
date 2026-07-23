import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_PERSISTED_STATE_MAX_BYTES,
  ORCA_PERSISTED_STATE_SECRET_MAX_BYTES
} from '../shared/persisted-state-file-bounds'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf8').replace(/^encrypted:/, '')
  }
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('./telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 0 })
}))

describe('Store persisted-state bounds', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-persistence-bounds-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  function dataFile(): string {
    return join(testState.dir, 'orca-data.json')
  }

  function backupFile(index: number): string {
    return `${dataFile()}.bak.${index}`
  }

  function writeMinimalState(path: string, theme: 'dark' | 'light'): string {
    const serialized = JSON.stringify({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { theme },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    writeFileSync(path, serialized)
    return serialized
  }

  async function createStore() {
    vi.resetModules()
    const { Store, initDataPath } = await import('./persistence')
    initDataPath()
    return new Store()
  }

  it('recovers atomically from an in-limit backup when the primary is oversized', async () => {
    writeFileSync(dataFile(), '')
    truncateSync(dataFile(), ORCA_PERSISTED_STATE_MAX_BYTES + 1)
    const backup = writeMinimalState(backupFile(0), 'dark')

    const store = await createStore()

    expect(store.getSettings().theme).toBe('dark')
    expect(readFileSync(dataFile(), 'utf8')).toBe(backup)
    store.updateSettings({ theme: 'light' })
    store.flushOrThrow()
    expect(JSON.parse(readFileSync(dataFile(), 'utf8')).settings.theme).toBe('light')
  })

  it('skips an oversized backup slot and recovers from the next bounded slot', async () => {
    writeFileSync(dataFile(), '{{corrupt')
    writeFileSync(backupFile(0), '')
    truncateSync(backupFile(0), ORCA_PERSISTED_STATE_MAX_BYTES + 1)
    writeMinimalState(backupFile(1), 'light')

    const store = await createStore()

    expect(store.getSettings().theme).toBe('light')
  })

  it('uses defaults but freezes writes when no bounded recovery source exists', async () => {
    vi.useFakeTimers()
    try {
      writeFileSync(dataFile(), '')
      truncateSync(dataFile(), ORCA_PERSISTED_STATE_MAX_BYTES + 1)
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const store = await createStore()
      store.updateSettings({ theme: 'dark' })
      await vi.advanceTimersByTimeAsync(2000)
      await store.waitForPendingWrite()
      store.flushOrThrow()

      expect(statSync(dataFile()).size).toBe(ORCA_PERSISTED_STATE_MAX_BYTES + 1)
      expect(errorSpy).toHaveBeenCalledWith(
        '[persistence] State exceeds the safe load limit; using defaults with state writes frozen'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the last valid file when a secret makes a sync flush exceed its bound', async () => {
    const store = await createStore()
    store.flushOrThrow()
    const validState = readFileSync(dataFile())
    store.updateSettings({
      opencodeSessionCookie: 'x'.repeat(ORCA_PERSISTED_STATE_SECRET_MAX_BYTES + 1)
    })

    expect(() => store.flushOrThrow()).toThrow('Persisted state secret exceeds')
    expect(readFileSync(dataFile())).toEqual(validState)
  })

  it('keeps the last valid file when an asynchronous bounded write is rejected', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.flushOrThrow()
      const validState = readFileSync(dataFile())
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      store.updateSettings({
        opencodeSessionCookie: 'x'.repeat(ORCA_PERSISTED_STATE_SECRET_MAX_BYTES + 1)
      })

      await vi.advanceTimersByTimeAsync(2000)
      await store.waitForPendingWrite()

      expect(readFileSync(dataFile())).toEqual(validState)
      expect(errorSpy).toHaveBeenCalledWith(
        '[persistence] Failed to write state:',
        expect.objectContaining({ name: 'PersistedStateSecretCapacityError' })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
