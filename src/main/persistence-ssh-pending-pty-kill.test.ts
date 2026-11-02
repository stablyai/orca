import {
  closeTestStores,
  testState,
  createStore,
  createStoreWithSshRemotePtyLeases
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const NOW = 1_800_000_000_000

// Relay-era builds record undelivered stops on the lease; this build only carries them so a
// downgrade can still replay them.
describe('persisted SSH pending PTY kills', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('carries fenced and epoch-scoped orders across a save and restart, and drops unfenced legacy ones', async () => {
    const store = createStoreWithSshRemotePtyLeases([
      {
        targetId: 'ssh-1',
        ptyId: 'pty-1',
        state: 'attached',
        pendingKill: { requestedAt: NOW, incarnationId: 'inc-a', attempts: 2 }
      },
      {
        targetId: 'ssh-1',
        ptyId: 'pty2:epoch-a:1',
        state: 'terminated',
        pendingKill: { requestedAt: NOW, attempts: 0 }
      },
      {
        targetId: 'ssh-1',
        ptyId: 'pty-2',
        state: 'terminated',
        pendingKill: { requestedAt: NOW, attempts: 0 }
      }
    ])
    store.updateUI({ sidebarWidth: 301 })
    store.flush()

    const reloaded = createStore()
    expect(
      reloaded.getSshRemotePtyLeases('ssh-1').map(({ ptyId, pendingKill }) => ({
        ptyId,
        pendingKill
      }))
    ).toEqual([
      { ptyId: 'pty-1', pendingKill: { requestedAt: NOW, incarnationId: 'inc-a', attempts: 2 } },
      { ptyId: 'pty2:epoch-a:1', pendingKill: { requestedAt: NOW, attempts: 0 } },
      { ptyId: 'pty-2', pendingKill: undefined }
    ])
  })
})
