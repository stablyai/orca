import { createWorkerMaintenanceFixture } from '../../persistence/loading-store/profile-state-maintenance-fixture'
import type { Store } from '../../persistence/loading-store/store'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'

import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Sync fsync/rename on stalled mounts blocks the quit deadline's own event loop.

const testState = { dir: '' }

const fsCalls = vi.hoisted(() => {
  const calls = {
    recording: false,
    dirPrefix: '',
    syncCalls: [] as string[],
    reset(): void {
      calls.syncCalls.length = 0
    },
    inScope(target: unknown): target is string {
      return (
        typeof target === 'string' && calls.dirPrefix !== '' && target.startsWith(calls.dirPrefix)
      )
    },
    recordSync(fn: string, target: unknown): void {
      if (calls.recording && calls.inScope(target)) {
        calls.syncCalls.push(`${fn}:${target}`)
      }
    }
  }
  return calls
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched: Record<string, unknown> = { ...actual }
  for (const name of Object.keys(actual)) {
    const original = (actual as unknown as Record<string, unknown>)[name]
    if (!name.endsWith('Sync') || typeof original !== 'function') {
      continue
    }
    const fn = original as (...args: unknown[]) => unknown
    const wrapper = (...args: unknown[]): unknown => {
      fsCalls.recordSync(name, args[0])
      return fn(...args)
    }
    patched[name] = Object.assign(wrapper, fn)
  }
  return { ...patched, default: patched }
})

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({ nth_repo_added: 2 })
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('enc:'.length)
  }
}))

const profiles = new Map<string, Awaited<ReturnType<typeof createWorkerMaintenanceFixture>>>()
const stores: Store[] = []

async function createStore(dir: string): Promise<Store> {
  testState.dir = dir
  const fixture = await createWorkerMaintenanceFixture({ directory: dir, profileId: 'quit-test' })
  profiles.set(dir, fixture)
  stores.push(fixture.store)
  fixture.store.updateUI({ activeView: 'terminal' })
  await fixture.store.flushPendingOrThrowAsync()
  await fixture.authority.drainBackups()
  return fixture.store
}

function readState(dir: string) {
  const profile = profiles.get(dir)
  if (!profile) {
    throw new Error('Missing test profile')
  }
  return profile.readState()
}

describe('quit-path durable writes never park the main thread', () => {
  const dirs: string[] = []

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-quit-path-'))
    dirs.push(dir)
    return dir
  }

  beforeEach(() => {
    fsCalls.recording = false
    fsCalls.dirPrefix = ''
    fsCalls.reset()
  })

  afterEach(async () => {
    fsCalls.recording = false
    vi.useRealTimers()
    await Promise.all(stores.splice(0).map((store) => store.freezeWritesAsync()))
    profiles.clear()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renderer unload staging issues no synchronous fs syscalls', async () => {
    const dir = makeDir()
    const store = await createStore(dir)

    fsCalls.dirPrefix = dir
    fsCalls.recording = true
    const leafId = '11111111-1111-4111-8111-111111111111'
    store.stageWorkspaceSessionBeforeUnload({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        'remote-repo::/remote': [
          {
            id: 'remote-tab',
            ptyId: 'remote-pty',
            worktreeId: 'remote-repo::/remote',
            title: 'Remote',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'remote-tab': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          buffersByLeafId: { [leafId]: 'remote-scrollback' }
        }
      },
      openFilesByWorktree: {}
    })
    fsCalls.recording = false

    expect(fsCalls.syncCalls).toEqual([])
    await store.flushAsync()
    const layout = readState(dir).workspaceSession.terminalLayoutsByTabId['remote-tab']
    const ref = layout.scrollbackRefsByLeafId[leafId]
    expect(layout.buffersByLeafId).toBeUndefined()
    expect(readFileSync(join(dir, 'terminal-scrollback', `${ref}.bin`), 'utf-8')).toBe(
      'remote-scrollback'
    )
  })
})
