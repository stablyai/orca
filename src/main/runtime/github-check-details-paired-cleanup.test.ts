import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withPairedCheckDetailsCleanup } from './github-check-details-paired-cleanup.test-fixture'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-paired-check-cleanup-'))
  const attempts: string[] = []
  const actions = {
    closeClient: vi.fn(() => {
      attempts.push('client')
    }),
    drain: vi.fn(async () => {
      attempts.push('drain')
    }),
    closeChildren: vi.fn(() => {
      attempts.push('positive-child-close')
    }),
    stopServer: vi.fn(async () => {
      attempts.push('server')
    }),
    removeDirectory: vi.fn(() => {
      attempts.push('directory')
      rmSync(directory, { recursive: true, force: true })
    })
  }
  return { directory, attempts, actions }
}

afterEach(() => vi.useRealTimers())

describe('paired check detail cleanup after failure', () => {
  it.each([false, true])(
    'attempts every cleanup after drain failure, prior failure %s',
    async (prior) => {
      const { directory, attempts, actions } = fixture()
      const drainFailure = new Error('forced drain failure')
      const original = new Error('original request assertion')
      actions.drain.mockImplementation(async () => {
        attempts.push('drain')
        throw drainFailure
      })
      await expect(
        withPairedCheckDetailsCleanup(actions, async () => {
          if (prior) {
            throw original
          }
        })
      ).rejects.toBe(prior ? original : drainFailure)
      expect(attempts).toEqual(['client', 'drain', 'positive-child-close', 'server', 'directory'])
      expect(existsSync(directory)).toBe(false)
    }
  )

  it.each([false, true])(
    'removes its directory after server stop failure, prior failure %s',
    async (prior) => {
      vi.useFakeTimers()
      const { directory, attempts, actions } = fixture()
      const stopFailure = new Error('forced server stop failure')
      const original = new Error('original request assertion')
      actions.stopServer.mockImplementation(async () => {
        attempts.push('server')
        throw stopFailure
      })
      await expect(
        withPairedCheckDetailsCleanup(actions, async () => {
          if (prior) {
            throw original
          }
        })
      ).rejects.toBe(prior ? original : stopFailure)
      expect(attempts).toEqual(['client', 'drain', 'positive-child-close', 'server', 'directory'])
      expect(existsSync(directory)).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([false, true])(
    'bounds stalled stop and observes its late rejection, prior failure %s',
    async (prior) => {
      vi.useFakeTimers()
      const { directory, attempts, actions } = fixture()
      const original = new Error('original request assertion')
      let rejectStop: (error: Error) => void = () => {
        throw new Error('Stop not started')
      }
      const stopped = new Promise<void>((_resolve, reject) => {
        rejectStop = reject
      })
      actions.stopServer.mockImplementation(() => {
        attempts.push('server')
        return stopped
      })
      const pending = withPairedCheckDetailsCleanup(
        actions,
        async () => {
          if (prior) {
            throw original
          }
        },
        25
      )
      const assertion = prior
        ? expect(pending).rejects.toBe(original)
        : expect(pending).rejects.toThrow('Paired check server stop timed out')
      await vi.advanceTimersByTimeAsync(25)
      await assertion
      expect(attempts).toEqual(['client', 'drain', 'positive-child-close', 'server', 'directory'])
      expect(existsSync(directory)).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      rejectStop(new Error('late stop failure'))
      await Promise.resolve()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
