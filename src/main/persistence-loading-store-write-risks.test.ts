import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import { Store } from './persistence/loading-store/store'
import { initDataPath } from './persistence/loading-store/user-data-path'

const testState = { dir: '' }

const writeControl = vi.hoisted(() => {
  let releaseRename: (() => void) | null = null
  let markRenameStarted: (() => void) | null = null
  return {
    blockPrimaryRename: false,
    failPrimaryOpen: false,
    renameStarted: Promise.resolve(),
    renameRelease: Promise.resolve(),
    reset(): void {
      this.blockPrimaryRename = false
      this.failPrimaryOpen = false
      this.renameStarted = new Promise<void>((resolve) => {
        markRenameStarted = resolve
      })
      this.renameRelease = new Promise<void>((resolve) => {
        releaseRename = resolve
      })
    },
    markRenameStarted(): void {
      markRenameStarted?.()
    },
    releaseRename(): void {
      releaseRename?.()
    }
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const target = String(args[0])
      if (
        writeControl.failPrimaryOpen &&
        target.includes('orca-data.json.') &&
        target.endsWith('.tmp')
      ) {
        throw Object.assign(new Error('profile mount rejected write'), { code: 'EIO' })
      }
      return actual.open(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const target = String(args[1])
      if (writeControl.blockPrimaryRename && target.endsWith('orca-data.json')) {
        writeControl.markRenameStarted()
        await writeControl.renameRelease
      }
      return actual.rename(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

function createStore(): Store {
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return new Store({ dataFile: join(testState.dir, 'orca-data.json') })
}

describe('loading Store write-risk characterization', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-write-risk-'))
    writeControl.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('allows an already-started primary rename to publish after writes are frozen', async () => {
    const store = await createStore()
    writeControl.blockPrimaryRename = true
    store.updateUI({ sidebarWidth: 712 })
    vi.advanceTimersByTime(1_000)
    await writeControl.renameStarted

    store.freezeWrites()
    writeControl.releaseRename()
    await store.waitForPendingWrite()

    const persisted = JSON.parse(readFileSync(join(testState.dir, 'orca-data.json'), 'utf-8')) as {
      ui: { sidebarWidth: number }
    }
    expect(persisted.ui.sidebarWidth).toBe(712)
  })

  it('keeps a rejected durable mutation in memory for a later unrelated flush', async () => {
    const store = await createStore()
    writeControl.failPrimaryOpen = true
    await expect(
      store.upsertSshPtyConsumerRecovery({
        targetId: 'ssh-1',
        clientInstanceId: 'client-1',
        serverBuildId: 'relay-build-1',
        clientGeneration: 3,
        ownerGeneration: 5,
        ownerLease: 'secret-owner-lease'
      })
    ).rejects.toThrow('profile mount rejected write')

    writeControl.failPrimaryOpen = false
    store.updateUI({ sidebarWidth: 713 })
    await store.flushPendingOrThrowAsync()
    const persisted = JSON.parse(readFileSync(join(testState.dir, 'orca-data.json'), 'utf-8')) as {
      sshPtyConsumerRecoveries: { clientInstanceId: string }[]
    }
    expect(persisted.sshPtyConsumerRecoveries[0]?.clientInstanceId).toBe('client-1')
  })
})
