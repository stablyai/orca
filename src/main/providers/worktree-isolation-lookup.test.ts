import { describe, expect, it, vi } from 'vitest'
import { WorktreeIsolationLookup } from './worktree-isolation-lookup'

describe('WorktreeIsolationLookup', () => {
  it('returns docker when the worktree meta is docker isolated', () => {
    const store = {
      getWorktreeMeta: vi.fn().mockReturnValue({ isolation: 'docker' })
    }

    expect(new WorktreeIsolationLookup(store as never).getIsolation('wt-1')).toBe('docker')
  })

  it('defaults to host when the worktree meta is missing', () => {
    const store = {
      getWorktreeMeta: vi.fn().mockReturnValue(undefined)
    }

    expect(new WorktreeIsolationLookup(store as never).getIsolation('wt-1')).toBe('host')
  })

  it('defaults to host when isolation is missing', () => {
    const store = {
      getWorktreeMeta: vi.fn().mockReturnValue({})
    }

    expect(new WorktreeIsolationLookup(store as never).getIsolation('wt-1')).toBe('host')
  })
})
