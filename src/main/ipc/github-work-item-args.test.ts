import { describe, expect, it, vi } from 'vitest'
import { dispatchWorkItem } from './github-work-item-args'

describe('dispatchWorkItem', () => {
  const repo = { path: '/r', connectionId: null }

  it('rejects non-integer numbers', () => {
    const fn = vi.fn()
    expect(dispatchWorkItem({ repoPath: '/r', number: 1.5 }, repo, fn)).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects numbers < 1', () => {
    const fn = vi.fn()
    expect(dispatchWorkItem({ repoPath: '/r', number: 0 }, repo, fn)).toBeNull()
    expect(dispatchWorkItem({ repoPath: '/r', number: -5 }, repo, fn)).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects non-number values coming across IPC', () => {
    const fn = vi.fn()
    // Renderer can send anything; simulate a string that slips past TS.
    const bogus = { repoPath: '/r', number: 'abc' as unknown as number }
    expect(dispatchWorkItem(bogus, repo, fn)).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('coerces unknown type values to undefined', async () => {
    const fn = vi.fn().mockResolvedValue(null)
    const bogus = {
      repoPath: '/r',
      number: 42,
      type: 'bogus' as unknown as 'issue' | 'pr'
    }
    await dispatchWorkItem(bogus, repo, fn)
    expect(fn).toHaveBeenCalledWith('/r', 42, undefined, null)
  })

  it('passes valid issue type through', async () => {
    const fn = vi.fn().mockResolvedValue(null)
    await dispatchWorkItem({ repoPath: '/r', number: 42, type: 'issue' }, repo, fn)
    expect(fn).toHaveBeenCalledWith('/r', 42, 'issue', null)
  })

  it('passes valid pr type through', async () => {
    const fn = vi.fn().mockResolvedValue(null)
    await dispatchWorkItem({ repoPath: '/r', number: 42, type: 'pr' }, repo, fn)
    expect(fn).toHaveBeenCalledWith('/r', 42, 'pr', null)
  })

  it('passes SSH connection context through', async () => {
    const fn = vi.fn().mockResolvedValue(null)
    await dispatchWorkItem(
      { repoPath: '/remote/repo', number: 42, type: 'issue' },
      { path: '/remote/repo', connectionId: 'ssh-1' },
      fn
    )
    expect(fn).toHaveBeenCalledWith('/remote/repo', 42, 'issue', 'ssh-1')
  })
})
