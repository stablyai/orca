import { expect, it, vi } from 'vitest'
import type { controlReleaseFixture } from '../persistence-orcad-live-retirement-installation.test'
import { createStore, testState } from '../persistence-test-harness'
import { liveRuntimeLifecycleFixture } from './orcad-live-runtime-lifecycle-test-fixture'
import { completeOrcadLiveMigration } from './orcad-live-migration-completion'
import { ptyOwnership } from '../ipc/pty/provider/ownership-state'
import * as durable from '../durable-file-write'
import { dataFile } from '../persistence-test-harness'
import { listSelectedOrcadLiveMigrations } from './orcad-live-migration-selection'

export function registerLiveCompletionLifecycleTests(fixture: typeof controlReleaseFixture) {
  it.each(['folder', 'worktree'] as const)(
    'retries a completed %s journal after its flush succeeds then throws without restamping',
    async (kind) => {
      const f = await liveRuntimeLifecycleFixture(fixture, kind)
      const options = {
        profileDirectory: testState.dir,
        store: f.store,
        migrationId: f.cutover.manifest.migrationId,
        runtime: f.runtime,
        remote: f.remote,
        activate: f.activate,
        signal: new AbortController().signal
      }
      const flush = f.store.flushPendingOrThrowAsync.bind(f.store)
      let interrupted = false
      vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockImplementation(async (args) => {
        await flush(args)
        if (
          !interrupted &&
          f.store.listOrcadMigrationSourceCutovers()[0]?.phase === 'source-retired'
        ) {
          interrupted = true
          throw new Error('final acknowledgment lost')
        }
      })
      await expect(f.run()).rejects.toThrow('final acknowledgment lost')
      const saved = createStore().listOrcadMigrationSourceCutovers()[0]
      expect(saved.phase).toBe('source-retired')
      expect(f.store.isOrcadLiveCompletionDurable(saved)).toBe(true)
      expect(
        listSelectedOrcadLiveMigrations(testState.dir, f.store, 'environment')[0].sourceRetirement
      ).toBe('complete')
      const reloaded = createStore()
      expect(reloaded.isOrcadLiveCompletionDurable(saved)).toBe(true)
      expect(
        listSelectedOrcadLiveMigrations(testState.dir, reloaded, 'environment')[0].sourceRetirement
      ).toBe('complete')
      const now = vi.fn(() => new Date('2030-01-01T00:00:00.000Z'))
      const recovered = await completeOrcadLiveMigration({ ...options, now })
      expect(recovered).toMatchObject({ sourceRetirement: 'complete', cutover: saved })
      expect(now).not.toHaveBeenCalled()
      await expect(f.run()).resolves.toMatchObject({ sourceRetirement: 'complete', cutover: saved })
      await expect(f.run(undefined, true, createStore())).resolves.toMatchObject({
        sourceRetirement: 'complete',
        cutover: saved
      })
      expect(createStore().listOrcadMigrationSourceCutovers()[0]).toEqual(saved)
      expect(f.releaseControl).toHaveBeenCalledTimes(2)
      expect(f.mux.dispose).not.toHaveBeenCalled()
    },
    120_000
  )

  it.each(['folder', 'worktree'] as const)(
    'keeps %s completion pending after a failure before the final profile write',
    async (kind) => {
      const f = await liveRuntimeLifecycleFixture(fixture, kind)
      const original = durable.renameDurable
      let failed = false
      vi.spyOn(durable, 'renameDurable').mockImplementation(async (...args) => {
        if (
          !failed &&
          args[1] === dataFile() &&
          f.store.listOrcadMigrationSourceCutovers()[0]?.phase === 'source-retired'
        ) {
          failed = true
          throw new Error('final profile rename failed')
        }
        return original(...args)
      })
      await expect(f.run()).rejects.toThrow('final profile rename failed')
      expect(failed).toBe(true)
      const candidate = f.store.listOrcadMigrationSourceCutovers()[0]
      expect(candidate.phase).toBe('source-retired')
      expect(createStore().listOrcadMigrationSourceCutovers()[0].phase).toBe(
        'destination-committed'
      )
      expect(f.store.isOrcadLiveCompletionDurable(candidate)).toBe(false)
      expect(
        listSelectedOrcadLiveMigrations(testState.dir, f.store, 'environment')[0].sourceRetirement
      ).toBe('pending')
      await expect(f.run()).resolves.toMatchObject({
        sourceRetirement: 'complete',
        cutover: candidate
      })
      expect(f.store.isOrcadLiveCompletionDurable(candidate)).toBe(true)
      expect(
        listSelectedOrcadLiveMigrations(testState.dir, f.store, 'environment')[0].sourceRetirement
      ).toBe('complete')
      expect(createStore().listOrcadMigrationSourceCutovers()[0]).toEqual(candidate)
    }
  )

  it('does not report completion while the final profile write is delayed', async () => {
    const f = await liveRuntimeLifecycleFixture(fixture, 'folder')
    const original = durable.renameDurable
    const release = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    vi.spyOn(durable, 'renameDurable').mockImplementation(async (...args) => {
      if (
        args[1] === dataFile() &&
        f.store.listOrcadMigrationSourceCutovers()[0]?.phase === 'source-retired'
      ) {
        reached.resolve()
        await release.promise
      }
      return original(...args)
    })
    const running = f.run()
    const outcome = running.then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    )
    try {
      await Promise.race([
        reached.promise,
        outcome.then((value) => {
          if ('error' in value) {
            throw value.error
          }
          throw new Error('final profile rename was not observed')
        })
      ])
      const candidate = f.store.listOrcadMigrationSourceCutovers()[0]
      expect(f.store.isOrcadLiveCompletionDurable(candidate)).toBe(false)
      expect(
        listSelectedOrcadLiveMigrations(testState.dir, f.store, 'environment')[0].sourceRetirement
      ).toBe('pending')
    } finally {
      release.resolve()
      await outcome
    }
    const result = await running
    expect(result.sourceRetirement).toBe('complete')
    expect(f.store.isOrcadLiveCompletionDurable(result.cutover)).toBe(true)
    expect(
      listSelectedOrcadLiveMigrations(testState.dir, f.store, 'environment')[0].sourceRetirement
    ).toBe('complete')
  }, 120_000)

  it('does not give a changed completed journal the earlier durable snapshot proof', async () => {
    const f = await liveRuntimeLifecycleFixture(fixture, 'folder')
    const result = await f.run()
    const changed = {
      ...result.cutover,
      retiredAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z'
    }
    expect(f.store.isOrcadLiveCompletionDurable(result.cutover)).toBe(true)
    expect(f.store.isOrcadLiveCompletionDurable(changed)).toBe(false)
    const inspect = f.store.inspectOrcadLiveRetirementProfileState.bind(f.store)
    vi.spyOn(f.store, 'inspectOrcadLiveRetirementProfileState').mockImplementation((record) => ({
      ...inspect(record),
      completedCutover: changed
    }))
    expect(
      listSelectedOrcadLiveMigrations(testState.dir, f.store, 'environment')[0].sourceRetirement
    ).toBe('pending')
  })

  it('refuses a completed retry when a source route reappears without deleting it', async () => {
    const f = await liveRuntimeLifecycleFixture(fixture, 'folder')
    await f.run()
    ptyOwnership.set(f.entries[0].ptyId, f.target.id)
    await expect(f.run(undefined, true, createStore())).rejects.toThrow('route_present')
    expect(ptyOwnership.get(f.entries[0].ptyId)).toBe(f.target.id)
    expect(f.releaseControl).toHaveBeenCalledTimes(2)
    expect(f.mux.dispose).not.toHaveBeenCalled()
  })

  it('refuses final acknowledgment when target authority changes during the profile flush', async () => {
    const f = await liveRuntimeLifecycleFixture(fixture, 'folder')
    const flush = f.store.flushPendingOrThrowAsync.bind(f.store)
    vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockImplementation(async (args) => {
      await flush(args)
      if (f.store.listOrcadMigrationSourceCutovers()[0]?.phase !== 'source-retired') {
        return
      }
      const getTarget = f.store.getSshTarget.bind(f.store)
      vi.spyOn(f.store, 'getSshTarget').mockImplementation((id) => {
        const target = getTarget(id)
        return target && id === f.target.id
          ? { ...target, generation: (target.generation ?? 0) + 1 }
          : target
      })
    })
    await expect(f.run()).rejects.toThrow()
    expect(f.mux.dispose).not.toHaveBeenCalled()
  })

  it('rejects a different valid-looking completed timestamp during final flush', async () => {
    const f = await liveRuntimeLifecycleFixture(fixture, 'folder')
    const flush = f.store.flushPendingOrThrowAsync.bind(f.store)
    const list = f.store.listOrcadMigrationSourceCutovers.bind(f.store)
    vi.spyOn(f.store, 'flushPendingOrThrowAsync').mockImplementation(async (args) => {
      await flush(args)
      if (list()[0]?.phase !== 'source-retired') {
        return
      }
      vi.spyOn(f.store, 'listOrcadMigrationSourceCutovers').mockImplementation(() =>
        list().map((journal) =>
          journal.phase === 'source-retired'
            ? {
                ...journal,
                retiredAt: '2030-01-01T00:00:00.000Z',
                updatedAt: '2030-01-01T00:00:00.000Z'
              }
            : journal
        )
      )
    })
    await expect(f.run()).rejects.toThrow('journal_changed')
  })
}
