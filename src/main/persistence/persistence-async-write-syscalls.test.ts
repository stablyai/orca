import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './loading-store/profile-state-maintenance-fixture'
import type { ProfileStateWorkerAuthority } from './profile-state/profile-state-worker-authority'

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
  function isSynchronousFilesystemCall(
    name: string,
    value: unknown
  ): value is (...args: unknown[]) => unknown {
    return name.endsWith('Sync') && typeof value === 'function'
  }

  const actual = await importOriginal<typeof NodeFs>()
  const patched: Record<string, unknown> = { ...actual }
  for (const [name, original] of Object.entries(actual)) {
    if (!isSynchronousFilesystemCall(name, original)) {
      continue
    }
    patched[name] = Object.assign((...args: unknown[]) => {
      const path = args[0]
      if (fsCalls.recording && typeof path === 'string' && path.startsWith(fsCalls.directory)) {
        fsCalls.sync.push(`${name}:${path}`)
      }
      return original(...args)
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
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
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

describe('worker persistence avoids synchronous profile filesystem calls', () => {
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

  it('serializes queued durable mutations and refuses a synchronous live flush', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const gate = pauseCommit(authority)
    const first = store.updateSettingsAndFlush({ terminalFontSize: 17 })
    await gate.started
    expect(() => store.flushOrThrow()).toThrow('awaited flush')
    const second = store.updateSettingsAndFlush({ terminalFontSize: 18 })
    await Promise.resolve()
    expect(
      vi.mocked(authority.writeSerializedDomains).mock.calls.length +
        vi.mocked(authority.writeCompleteSerializedDomains).mock.calls.length
    ).toBe(1)
    gate.release()
    await Promise.all([first, second])
    expect(readState().settings.terminalFontSize).toBe(18)
  })
})
