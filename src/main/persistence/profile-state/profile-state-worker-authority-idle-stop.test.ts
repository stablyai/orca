import { describe, expect, it, vi } from 'vitest'
import type * as WriterThreadModule from './profile-state-writer-thread'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import { createWorkerMaintenanceFixture } from '../loading-store/profile-state-maintenance-fixture'

const threadFailures = vi.hoisted(() => ({ remaining: 0, constructed: 0 }))
vi.mock('./profile-state-writer-thread', async (importOriginal) => {
  const actual = await importOriginal<typeof WriterThreadModule>()
  class FailingOnDemandThread extends actual.ProfileStateWriterThread {
    constructor(...args: ConstructorParameters<typeof actual.ProfileStateWriterThread>) {
      threadFailures.constructed += 1
      if (threadFailures.remaining > 0) {
        threadFailures.remaining -= 1
        throw new Error('EMFILE: too many open files')
      }
      super(...args)
    }
  }
  return { ...actual, ProfileStateWriterThread: FailingOnDemandThread }
})
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const IDLE_MS = 40

/** Resolves once the idle writer has fully closed. */
async function idleStopped(close: ReturnType<typeof vi.spyOn>, calls = 1): Promise<void> {
  await expect.poll(() => close.mock.calls.length, { timeout: 5_000 }).toBe(calls)
  await close.mock.results.at(-1)?.value
}

async function idleFixture(onFailure?: (error: Error) => void) {
  const close = vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'close')
  const fixture = await createWorkerMaintenanceFixture(undefined, onFailure, IDLE_MS)
  return { ...fixture, close }
}

describe('worker authority idle stop', () => {
  it('retries a failed reopen on the next write instead of wedging saving', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { authority, close, readState } = await idleFixture()
    await idleStopped(close)
    threadFailures.remaining = 1
    await expect(
      authority.writeSerializedDomains([{ domain: 'ui', payload: '{"lost":true}' }])
    ).rejects.toMatchObject({ code: 'profile-state-writer-unavailable' })
    expect(() => authority.assertWritable()).not.toThrow()
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"retried":true}' }])
    expect(readState().ui).toEqual({ retried: true })
  })

  it('gives the final flush one reopen attempt inside a backoff, and it lands', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { authority, close, store, readState } = await idleFixture()
    await idleStopped(close)
    threadFailures.remaining = 2
    const write = () => authority.writeSerializedDomains([{ domain: 'ui', payload: '{}' }])
    await expect(write()).rejects.toMatchObject({ code: 'profile-state-writer-unavailable' })
    await expect(write()).rejects.toMatchObject({ code: 'profile-state-writer-unavailable' })
    store.updateSettings({ theme: 'dark' })
    await store.flushFinalOrThrowAsync()
    expect(readState().settings.theme).toBe('dark')
  })

  it('refuses the next write when the database changed while the writer was stopped', async () => {
    const notify = vi.fn()
    const { authority, close, peer } = await idleFixture(notify)
    await idleStopped(close)
    const other = peer()
    other.writeSerializedDomains([{ domain: 'ui', payload: '{"external":true}' }])
    other.close()
    await expect(
      authority.writeSerializedDomains([{ domain: 'ui', payload: '{"mine":true}' }])
    ).rejects.toMatchObject({ code: 'profile-state-revision-conflict' })
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'profile-state-revision-conflict' })
    )
    expect(() => authority.assertWritable()).toThrow()
  })
})
