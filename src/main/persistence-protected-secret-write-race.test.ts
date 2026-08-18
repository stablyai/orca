import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testState = { dir: '' }
const cipherState = { available: true }

const renameGate = vi.hoisted(() => ({
  sourcePrefix: '',
  release: null as Promise<void> | null,
  started: null as (() => void) | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      if (renameGate.release && source.startsWith(renameGate.sourcePrefix)) {
        const release = renameGate.release
        renameGate.release = null
        renameGate.started?.()
        await release
      }
      return actual.rename(source, destination)
    }
  }
})

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => cipherState.available,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('enc:'.length)
  }
}))

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('protected-secret async write retention', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-protected-secret-write-race-'))
    cipherState.available = true
    renameGate.sourcePrefix = join(testState.dir, 'orca-data.json')
    renameGate.release = null
    renameGate.started = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('does not retain ciphertext from a superseded async secret write', async () => {
    const store = await createStore()
    store.updateSettings({ opencodeSessionCookie: 'durable-cookie' })
    vi.advanceTimersByTime(1_000)
    await store.waitForPendingWrite()

    const renameRelease = deferred()
    const renameStarted = deferred()
    renameGate.release = renameRelease.promise
    renameGate.started = renameStarted.resolve

    store.updateSettings({ opencodeSessionCookie: 'intermediate-cookie' })
    vi.advanceTimersByTime(1_000)
    await renameStarted.promise

    store.updateSettings({ opencodeSessionCookie: 'replacement-cookie' })
    cipherState.available = false
    vi.advanceTimersByTime(1_000)
    renameRelease.resolve()
    await store.waitForPendingWrite()

    cipherState.available = true
    const restarted = await createStore()
    expect(restarted.getSettings().opencodeSessionCookie).toBe('durable-cookie')
  })
})
