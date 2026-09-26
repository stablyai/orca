import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import {
  createWorkerMaintenanceFixture,
  createSqliteMaintenanceFixture,
  maintenanceBarrier
} from './persistence/loading-store/profile-state-maintenance-fixture'
import { profileStateDatabaseBackups } from './persistence/profile-state/profile-state-backup-path'
import { ProfileStateSqliteAuthority } from './persistence/profile-state/profile-state-sqlite-authority'
import type { ProfileStateWorkerAuthority } from './persistence/profile-state/profile-state-worker-authority'

type FilesystemCalls = {
  directory: string
  recording: boolean
  sync: string[]
  waitAsync: ((name: string, path: string) => Promise<void> | undefined) | undefined
}

const fsCalls = vi.hoisted((): FilesystemCalls => ({
  directory: '',
  recording: false,
  sync: [],
  waitAsync: undefined
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const patched: Record<string, unknown> = { ...actual }
  for (const [name, original] of Object.entries(actual)) {
    if (!name.endsWith('Sync') || typeof original !== 'function') {
      continue
    }
    patched[name] = Object.assign((...args: unknown[]) => {
      const path = args[0]
      if (fsCalls.recording && typeof path === 'string' && path.startsWith(fsCalls.directory)) {
        fsCalls.sync.push(`${name}:${path}`)
      }
      return Reflect.apply(original, undefined, args)
    }, original)
  }
  return { ...patched, default: patched }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (typeof args[0] === 'string') {
        await fsCalls.waitAsync?.('rename', args[0])
      }
      return actual.rename(...args)
    }
  }
})
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({ nth_repo_added: 2 }) }))
vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

beforeEach(() => {
  fsCalls.recording = false
  fsCalls.directory = ''
  fsCalls.sync = []
  fsCalls.waitAsync = undefined
})
afterEach(() => {
  fsCalls.recording = false
})

function record(directory: string): void {
  fsCalls.directory = directory
  fsCalls.sync = []
  fsCalls.recording = true
}

function pauseCommit(authority: ProfileStateWorkerAuthority) {
  const started = maintenanceBarrier()
  const finish = maintenanceBarrier()
  let held = false
  for (const name of ['writeSerializedDomains', 'writeCompleteSerializedDomains'] as const) {
    const original = authority[name].bind(authority)
    vi.spyOn(authority, name).mockImplementation(async (replacements) => {
      if (!held) {
        held = true
        started.resolve()
        await finish.promise
      }
      await original(replacements)
    })
  }
  return { started: started.promise, release: finish.resolve }
}

function consumerRecovery(clientInstanceId: string) {
  return {
    targetId: 'ssh-1',
    clientInstanceId,
    serverBuildId: 'relay-build-1',
    clientGeneration: 3,
    ownerGeneration: 5,
    ownerLease: 'secret-owner-lease'
  }
}

function readBackup(path: string) {
  const reader = new ProfileStateSqliteAuthority(path, 'maintenance-test')
  try {
    return JSON.parse(reader.readSerializedState() ?? '{}')
  } finally {
    reader.close()
  }
}

describe('worker persistence avoids synchronous profile filesystem calls', () => {
  it('commits and creates a real SQLite backup without synchronous profile syscalls', async () => {
    const { store, authority, directory, databaseFile, dataFile, readState } =
      await createWorkerMaintenanceFixture()
    record(directory)
    store.updateUI({ sidebarWidth: 301 })
    await store.flushPendingOrThrowAsync()
    await authority.drainBackups()
    fsCalls.recording = false
    expect(fsCalls.sync).toEqual([])
    expect(readState().ui.sidebarWidth).toBe(301)
    const backups = profileStateDatabaseBackups(databaseFile)
    expect(backups).toHaveLength(1)
    expect(readBackup(backups[0].path).ui.sidebarWidth).toBe(301)
    expect(existsSync(dataFile)).toBe(false)
    expect(existsSync(`${dataFile}.bak.0`)).toBe(false)
  })

  it('keeps five hourly SQL backups and skips rotation within the hour without sync syscalls', async () => {
    const start = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(start)
    const { store, authority, directory, databaseFile } = await createWorkerMaintenanceFixture()
    record(directory)
    for (let index = 0; index < 6; index++) {
      vi.mocked(Date.now).mockReturnValue(start + index * 3_600_001)
      store.updateUI({ sidebarWidth: 310 + index })
      await store.flushPendingOrThrowAsync()
      await authority.drainBackups()
    }
    store.updateUI({ sidebarWidth: 399 })
    await store.flushPendingOrThrowAsync()
    await authority.drainBackups()
    fsCalls.recording = false
    expect(fsCalls.sync).toEqual([])
    const backups = profileStateDatabaseBackups(databaseFile)
    expect(backups).toHaveLength(5)
    expect(backups.map((backup) => readBackup(backup.path).ui.sidebarWidth)).toEqual([
      315, 314, 313, 312, 311
    ])
  })

  it('keeps the event loop live while a SQL acknowledgement is stalled', async () => {
    const { store, authority, directory, readState } = await createWorkerMaintenanceFixture()
    const gate = pauseCommit(authority)
    record(directory)
    const pending = store.upsertSshPtyConsumerRecovery(consumerRecovery('client-1'))
    await gate.started
    let complete = false
    void pending.then(() => {
      complete = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(complete).toBe(false)
    expect(fsCalls.sync).toEqual([])
    gate.release()
    await pending
    fsCalls.recording = false
    expect(readState().sshPtyConsumerRecoveries[0].clientInstanceId).toBe('client-1')
  })

  it('drains a newer mutation before resolving a stable-generation barrier', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const gate = pauseCommit(authority)
    store.updateUI({ sidebarWidth: 601 })
    const barrier = store.flushPendingOrThrowAsync()
    await gate.started
    store.updateUI({ sidebarWidth: 602 })
    gate.release()
    await barrier
    expect(readState().ui.sidebarWidth).toBe(602)
  })

  it('bounds a best-effort flush to its captured generation and retains later dirtiness', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const gate = pauseCommit(authority)
    store.updateUI({ sidebarWidth: 621 })
    const pending = store.flushPendingAsync()
    await gate.started
    store.updateUI({ sidebarWidth: 622 })
    gate.release()
    await pending
    expect(readState().ui.sidebarWidth).toBe(621)
    await store.flushPendingOrThrowAsync()
    expect(readState().ui.sidebarWidth).toBe(622)
  })

  it('rewrites an earlier value after a captured stale generation commits', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    store.updateUI({ sidebarWidth: 641 })
    await store.flushPendingOrThrowAsync()
    const gate = pauseCommit(authority)
    store.updateUI({ sidebarWidth: 642 })
    const pending = store.flushPendingAsync()
    await gate.started
    store.updateUI({ sidebarWidth: 641 })
    gate.release()
    await pending
    expect(readState().ui.sidebarWidth).toBe(642)
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    expect(readState().ui.sidebarWidth).toBe(641)
  })

  it('retains dirty state when a SQL commit fails and persists an explicit retry', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockRejectedValueOnce(
      new Error('disk refused')
    )
    const original = readState().ui.sidebarWidth
    store.updateUI({ sidebarWidth: 511 })
    await store.flushPendingAsync()
    expect(readState().ui.sidebarWidth).toBe(original)
    await store.flushPendingOrThrowAsync()
    expect(readState().ui.sidebarWidth).toBe(511)
  })

  it('drains mutations made while a sidecar rename is stalled', async () => {
    const { store, readState } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const finish = maintenanceBarrier()
    fsCalls.waitAsync = (name, path) => {
      if (name !== 'rename' || !path.includes('orca-github-cache.json.')) {
        return
      }
      started.resolve()
      return finish.promise
    }
    store.updateUI({ sidebarWidth: 611 })
    store.setGitHubCache({ pr: {}, issue: {} })
    const barrier = store.flushPendingOrThrowAsync()
    await started.promise
    store.updateUI({ sidebarWidth: 612 })
    finish.resolve()
    await barrier
    expect(readState().ui.sidebarWidth).toBe(612)
  })

  it('persists SSH consumer recovery without sync syscalls before acknowledging it', async () => {
    const { store, authority, directory, readState } = await createWorkerMaintenanceFixture()
    record(directory)
    await store.upsertSshPtyConsumerRecovery(consumerRecovery('client-1'))
    await authority.drainBackups()
    fsCalls.recording = false
    expect(fsCalls.sync).toEqual([])
    expect(readState().sshPtyConsumerRecoveries).toEqual([
      expect.objectContaining({ clientInstanceId: 'client-1' })
    ])
  })

  it('rejects failed consumer recovery and preserves the prior durable state', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const before = readState().sshPtyConsumerRecoveries
    const failure = new Error('profile mount rejected write')
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockRejectedValueOnce(failure)
    await expect(store.upsertSshPtyConsumerRecovery(consumerRecovery('client-1'))).rejects.toBe(
      failure
    )
    expect(readState().sshPtyConsumerRecoveries).toEqual(before)
  })

  it('durably removes SSH consumer recovery without sync syscalls', async () => {
    const { store, authority, directory, readState } = await createWorkerMaintenanceFixture()
    await store.upsertSshPtyConsumerRecovery(consumerRecovery('client-1'))
    await authority.drainBackups()
    record(directory)
    await store.removeSshPtyConsumerRecovery('ssh-1')
    await authority.drainBackups()
    fsCalls.recording = false
    expect(fsCalls.sync).toEqual([])
    expect(readState().sshPtyConsumerRecoveries).toEqual([])
  })

  it('persists lease detachment and selected reattachments without sync syscalls', async () => {
    const { store, authority, directory, readState } = await createWorkerMaintenanceFixture()
    for (const [ptyId, state] of [
      ['pty-1', 'attached'],
      ['pty-2', 'expired'],
      ['pty-3', 'detached'],
      ['pty-4', 'terminated']
    ] as const) {
      store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId, state })
    }
    record(directory)
    await store.markSshRemotePtyLeasesAsync('ssh-1', 'detached')
    await authority.drainBackups()
    fsCalls.recording = false
    expect(fsCalls.sync).toEqual([])
    expect(
      readState().sshRemotePtyLeases.filter(
        (lease: { targetId: string }) => lease.targetId === 'ssh-1'
      )
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ ptyId: 'pty-1', state: 'detached' })])
    )
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-2', state: 'expired' })
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'pty-4', state: 'terminated' })
    record(directory)
    const write = vi.spyOn(authority, 'writeSerializedDomains')
    await store.markSshRemotePtyLeasesAttachedAsync('ssh-1', ['pty-1', 'pty-2', 'pty-4'])
    await authority.drainBackups()
    fsCalls.recording = false
    expect(fsCalls.sync).toEqual([])
    expect(write).toHaveBeenCalledOnce()
    expect(readState().sshRemotePtyLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ptyId: 'pty-1', state: 'attached' }),
        expect.objectContaining({ ptyId: 'pty-2', state: 'attached' }),
        expect.objectContaining({ ptyId: 'pty-3', state: 'detached' }),
        expect.objectContaining({ ptyId: 'pty-4', state: 'terminated' })
      ])
    )
  })

  it('serializes queued durable mutations and refuses a synchronous live flush', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const gate = pauseCommit(authority)
    const first = store.upsertSshPtyConsumerRecovery(consumerRecovery('client-1'))
    await gate.started
    expect(() => store.flushOrThrow()).toThrow('awaited flush')
    const second = store.upsertSshPtyConsumerRecovery(consumerRecovery('client-2'))
    await Promise.resolve()
    expect(
      vi.mocked(authority.writeSerializedDomains).mock.calls.length +
        vi.mocked(authority.writeCompleteSerializedDomains).mock.calls.length
    ).toBe(1)
    gate.release()
    await Promise.all([first, second])
    expect(readState().sshPtyConsumerRecoveries[0].clientInstanceId).toBe('client-2')
  })

  it('keeps admitted offline SQL checkpoints synchronous and durable', () => {
    const { store, authority, dataFile } = createSqliteMaintenanceFixture()
    const write = vi.spyOn(authority, 'writeCompleteSerializedDomains')
    store.updateUI({ sidebarWidth: 331 })
    store.flushOrThrow()
    expect(write).toHaveBeenCalledOnce()
    expect(JSON.parse(authority.readSerializedState() ?? '{}').ui.sidebarWidth).toBe(331)
    expect(existsSync(dataFile)).toBe(false)
  })
})
