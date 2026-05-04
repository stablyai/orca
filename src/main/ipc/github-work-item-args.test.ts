import { describe, expect, it, vi } from 'vitest'
import { dispatchWorkItem } from './github-work-item-args'

describe('dispatchWorkItem', () => {
  it('rejects non-integer numbers', () => {
    const fn = vi.fn()
    expect(dispatchWorkItem({ repoPath: '/r', number: 1.5 }, '/r', fn)).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects numbers < 1', () => {
    const fn = vi.fn()
    expect(dispatchWorkItem({ repoPath: '/r', number: 0 }, '/r', fn)).toBeNull()
    expect(dispatchWorkItem({ repoPath: '/r', number: -5 }, '/r', fn)).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects non-number values coming across IPC', () => {
    const fn = vi.fn()
    // Renderer can send anything; simulate a string that slips past TS.
    const bogus = { repoPath: '/r', number: 'abc' as unknown as number }
    expect(dispatchWorkItem(bogus, '/r', fn)).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('coerces unknown type values to undefined', async () => {
    const fn = vi.fn().mockResolvedValue(null)
    const bogus = {
      repoPath: '/r',
      number: 42,
      type: 'bogus' as unknown as 'issue' | 'pr'
    }
    await dispatchWorkItem(bogus, '/r', fn)
    expect(fn).toHaveBeenCalledWith('/r', 42, undefined)
  })

  it('passes valid issue type through', async () => {
    const fn = vi.fn().mockResolvedValue(null)
    await dispatchWorkItem({ repoPath: '/r', number: 42, type: 'issue' }, '/r', fn)
    expect(fn).toHaveBeenCalledWith('/r', 42, 'issue')
  })

  it('passes valid pr type through', async () => {
    const fn = vi.fn().mockResolvedValue(null)
    await dispatchWorkItem({ repoPath: '/r', number: 42, type: 'pr' }, '/r', fn)
    expect(fn).toHaveBeenCalledWith('/r', 42, 'pr')
  })
})
