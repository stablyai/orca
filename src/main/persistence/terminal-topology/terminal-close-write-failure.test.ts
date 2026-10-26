import { describe, expect, it, vi } from 'vitest'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { keptOnWriteFailure } from './terminal-close-write-failure'

function durableRun(write: () => void) {
  return async <V>(mutate: () => DurableProfileStateMutation<V>): Promise<V> => {
    const mutation = mutate()
    try {
      write()
    } catch (error) {
      mutation.rollback?.()
      throw error
    }
    return mutation.value
  }
}

describe('a terminal close whose profile write fails', () => {
  it('stays closed, answers as applied, and is written again later', async () => {
    let tabs = ['tab-1', 'tab-2']
    const writeLater = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reply = await keptOnWriteFailure(
      durableRun(() => {
        throw new Error('ENOSPC')
      }),
      () => {
        const before = tabs
        tabs = tabs.filter((tab) => tab !== 'tab-2')
        return { value: { ok: true as const }, rollback: () => (tabs = before) }
      },
      writeLater
    )
    expect(reply).toEqual({ ok: true })
    expect(tabs).toEqual(['tab-1'])
    expect(writeLater).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('refuses a close the profile froze before it changed anything', async () => {
    const writeLater = vi.fn()
    const mutate = vi.fn()
    await expect(
      keptOnWriteFailure(
        async () => {
          throw new Error('Cannot mutate finalized profile persistence')
        },
        mutate,
        writeLater
      )
    ).rejects.toThrow('finalized')
    expect(mutate).not.toHaveBeenCalled()
    expect(writeLater).not.toHaveBeenCalled()
  })
})
