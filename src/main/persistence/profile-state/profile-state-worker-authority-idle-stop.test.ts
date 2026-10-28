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
  it('keeps the writer running, with no idle timer, when no idle stop is configured', async () => {
    const close = vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'close')
    const { authority } = await createWorkerMaintenanceFixture()
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"unset":true}' }])
    // No timer is armed, so nothing can stop the writer later.
    expect(authority.writerIdleStopPending).toBe(false)
    expect(close).not.toHaveBeenCalled()
    authority.assertWritable()
  })

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

  it('never reports a recovered reopen blip as saving having stopped', async () => {
    const notify = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { authority, close, readState } = await idleFixture(notify)
    await idleStopped(close)
    threadFailures.remaining = 1
    await expect(
      authority.writeSerializedDomains([{ domain: 'ui', payload: '{"blip":true}' }])
    ).rejects.toMatchObject({ code: 'profile-state-writer-unavailable' })
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"recovered":true}' }])
    expect(readState().ui).toEqual({ recovered: true })
    expect(notify).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('retrying in 0 ms'),
      expect.objectContaining({ code: 'profile-state-writer-unavailable' })
    )
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

  it('backs off after repeated reopen failures without spawning again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { authority, close } = await idleFixture()
    await idleStopped(close)
    threadFailures.remaining = 2
    const write = () => authority.writeSerializedDomains([{ domain: 'ui', payload: '{}' }])
    await expect(write()).rejects.toMatchObject({ code: 'profile-state-writer-unavailable' })
    await expect(write()).rejects.toMatchObject({ code: 'profile-state-writer-unavailable' })
    const spawned = threadFailures.constructed
    await expect(write()).rejects.toMatchObject({ code: 'profile-state-writer-unavailable' })
    expect(threadFailures.constructed).toBe(spawned)
  })

  it('stops an idle writer, stays writable, and reopens it for the next write', async () => {
    const { authority, close, readState } = await idleFixture()
    await idleStopped(close)
    expect(() => authority.assertWritable()).not.toThrow()
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"after":"idle"}' }])
    expect(readState().ui).toEqual({ after: 'idle' })
    // The reopened writer idles out again.
    await idleStopped(close, 2)
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"after":"second"}' }])
    expect(readState().ui).toEqual({ after: 'second' })
    expect(authority.writerReopenCount).toBe(2)
  })

  it('counts every reopen but logs churn at most once per window', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { authority, close } = await idleFixture()
    for (const [round, payload] of ['{"n":1}', '{"n":2}'].entries()) {
      await idleStopped(close, round + 1)
      await authority.writeSerializedDomains([{ domain: 'ui', payload }])
    }
    expect(authority.writerReopenCount).toBe(2)
    const reopenLines = info.mock.calls.filter(([line]) => String(line).includes('Reopened'))
    expect(reopenLines).toHaveLength(1)
  })

  it('lands a write that arrives while the stop is closing the writer', async () => {
    const { authority, close, readState } = await idleFixture()
    await expect.poll(() => close.mock.calls.length, { timeout: 5_000 }).toBe(1)
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"raced":true}' }])
    expect(readState().ui).toEqual({ raced: true })
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

  it('still refuses with the revision conflict when the failure listener throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { authority, close, peer } = await idleFixture(() => {
      throw new Error('listener broke')
    })
    await idleStopped(close)
    const other = peer()
    other.writeSerializedDomains([{ domain: 'ui', payload: '{"external":true}' }])
    other.close()
    await expect(
      authority.writeSerializedDomains([{ domain: 'ui', payload: '{"mine":true}' }])
    ).rejects.toMatchObject({ code: 'profile-state-revision-conflict' })
  })

  it('closes cleanly while stopped and refuses later writes', async () => {
    const { authority, close } = await idleFixture()
    await idleStopped(close)
    await authority.close()
    expect(() => authority.assertWritable()).toThrow('closing')
    await expect(
      authority.writeSerializedDomains([{ domain: 'ui', payload: '{}' }])
    ).rejects.toMatchObject({ code: 'profile-state-writer-closed' })
  })

  it('pauses for maintenance while stopped and resumes at the stopped revision', async () => {
    const { authority, close, readState } = await idleFixture()
    await idleStopped(close)
    const maintenance = await authority.pauseForMaintenance()
    await maintenance.resume()
    await authority.writeSerializedDomains([{ domain: 'ui', payload: '{"resumed":true}' }])
    expect(readState().ui).toEqual({ resumed: true })
  })

  it('quarantines the database while stopped', async () => {
    const { authority, close } = await idleFixture()
    await idleStopped(close)
    await expect(authority.quarantineDatabase()).resolves.toBeDefined()
  })

  it('stays failed after an abort while stopped', async () => {
    const { authority, close } = await idleFixture()
    await idleStopped(close)
    await authority.abort()
    expect(() => authority.assertWritable()).toThrow('aborted')
    await expect(
      authority.writeSerializedDomains([{ domain: 'ui', payload: '{}' }])
    ).rejects.toMatchObject({ code: 'profile-state-writer-aborted' })
  })
})
