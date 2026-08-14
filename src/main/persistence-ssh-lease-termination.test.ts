import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../shared/constants'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const TARGET = 'ssh-target-1'

type DurableFlushStore = {
  flushDurableStateOrThrowAsync: (drainToStableGeneration?: boolean) => Promise<void>
}

function lease(ptyId: string, state: 'attached' | 'detached') {
  return {
    targetId: TARGET,
    ptyId,
    state,
    createdAt: 1,
    updatedAt: 1
  }
}

async function createStore() {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      sshRemotePtyLeases: [
        lease('pty-1', 'detached'),
        lease('pty-2', 'attached'),
        lease('pty-3', 'detached')
      ]
    }),
    'utf-8'
  )
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-ssh-lease-termination-'))
})

afterEach(() => {
  rmSync(testState.dir, { force: true, recursive: true })
})

describe('SSH lease termination persistence', () => {
  it('updates only selected leases and awaits one asynchronous durability barrier', async () => {
    const store = await createStore()
    const asyncFlush = vi
      .spyOn(store as unknown as DurableFlushStore, 'flushDurableStateOrThrowAsync')
      .mockResolvedValue()
    const syncFlush = vi.spyOn(store, 'flush')
    const syncFlushOrThrow = vi.spyOn(store, 'flushOrThrow')

    await store.markSshRemotePtyLeasesTerminatedAsync(TARGET, ['pty-1', 'pty-3'])

    expect(asyncFlush).toHaveBeenCalledOnce()
    expect(asyncFlush).toHaveBeenCalledWith(false)
    expect(syncFlush).not.toHaveBeenCalled()
    expect(syncFlushOrThrow).not.toHaveBeenCalled()
    expect(store.getSshRemotePtyLeases(TARGET)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ptyId: 'pty-1', state: 'terminated' }),
        expect.objectContaining({ ptyId: 'pty-2', state: 'attached' }),
        expect.objectContaining({ ptyId: 'pty-3', state: 'terminated' })
      ])
    )
  })

  it('does not overwrite concurrent lease state when durability fails', async () => {
    const store = await createStore()
    const writeError = new Error('disk full')
    const asyncFlush = vi
      .spyOn(store as unknown as DurableFlushStore, 'flushDurableStateOrThrowAsync')
      .mockRejectedValue(writeError)
    const scheduleSave = vi.spyOn(store as unknown as { scheduleSave: () => void }, 'scheduleSave')
    scheduleSave.mockClear()

    const retirement = store.markSshRemotePtyLeasesTerminatedAsync(TARGET, ['pty-1'])
    store.markSshRemotePtyLeasesForShutdown(TARGET, 'detached')

    await expect(retirement).rejects.toBe(writeError)
    expect(scheduleSave).toHaveBeenCalledTimes(2)
    expect(store.getSshRemotePtyLeases(TARGET)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ptyId: 'pty-1', state: 'terminated' }),
        expect.objectContaining({ ptyId: 'pty-2', state: 'detached' })
      ])
    )

    asyncFlush.mockRestore()
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    const persisted = JSON.parse(readFileSync(join(testState.dir, 'orca-data.json'), 'utf-8')) as {
      sshRemotePtyLeases: { ptyId: string; state: string }[]
    }
    expect(persisted.sshRemotePtyLeases).toContainEqual(
      expect.objectContaining({ ptyId: 'pty-1', state: 'terminated' })
    )
  })

  it('does not write when no requested lease exists', async () => {
    const store = await createStore()
    const asyncFlush = vi.spyOn(
      store as unknown as DurableFlushStore,
      'flushDurableStateOrThrowAsync'
    )

    await store.markSshRemotePtyLeasesTerminatedAsync(TARGET, ['missing'])

    expect(asyncFlush).not.toHaveBeenCalled()
  })

  it('does not chase mutations made after the retirement generation is durable', async () => {
    const store = await createStore()
    const internal = store as unknown as { enqueueWrite: () => Promise<void> }
    const enqueueWrite = internal.enqueueWrite.bind(store)
    let injectedMutation = false
    const enqueueSpy = vi.spyOn(internal, 'enqueueWrite').mockImplementation(async () => {
      await enqueueWrite()
      if (!injectedMutation) {
        injectedMutation = true
        store.updateUI({ sidebarWidth: 777 })
      }
    })

    await store.markSshRemotePtyLeasesTerminatedAsync(TARGET, ['pty-1'])

    expect(enqueueSpy).toHaveBeenCalledOnce()
    const persisted = JSON.parse(readFileSync(join(testState.dir, 'orca-data.json'), 'utf-8')) as {
      sshRemotePtyLeases: { ptyId: string; state: string }[]
    }
    expect(persisted.sshRemotePtyLeases).toContainEqual(
      expect.objectContaining({ ptyId: 'pty-1', state: 'terminated' })
    )
    enqueueSpy.mockRestore()
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
  })
})
