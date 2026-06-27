import { describe, expect, it } from 'vitest'
import { isGroupAddress, resolveGroupAddress } from './groups'
import type { RuntimeTerminalSummary } from '../../../shared/runtime-types'

function makeSummary(
  handle: string,
  opts: Partial<RuntimeTerminalSummary> = {}
): RuntimeTerminalSummary {
  return {
    handle,
    ptyId: opts.ptyId ?? handle,
    worktreeId: opts.worktreeId ?? 'wt_default',
    worktreePath: opts.worktreePath ?? '/tmp/wt',
    branch: opts.branch ?? 'main',
    tabId: opts.tabId ?? 'tab_1',
    leafId: opts.leafId ?? handle,
    title: opts.title ?? null,
    connected: opts.connected ?? true,
    writable: opts.writable ?? true,
    lastOutputAt: opts.lastOutputAt ?? null,
    preview: opts.preview ?? ''
  }
}

const noStatus = () => null

describe('isGroupAddress', () => {
  it('returns true for @-prefixed addresses', () => {
    expect(isGroupAddress('@all')).toBe(true)
    expect(isGroupAddress('@idle')).toBe(true)
    expect(isGroupAddress('@claude')).toBe(true)
    expect(isGroupAddress('@droid')).toBe(true)
    expect(isGroupAddress('@worktree:wt_1')).toBe(true)
  })

  it('returns false for regular handles', () => {
    expect(isGroupAddress('term_abc')).toBe(false)
    expect(isGroupAddress('coordinator')).toBe(false)
    expect(isGroupAddress('')).toBe(false)
  })
})

describe('resolveGroupAddress', () => {
  it('returns the address as-is for non-group addresses', () => {
    const result = resolveGroupAddress('term_b', 'term_a', [], noStatus)
    expect(result).toEqual(['term_b'])
  })

  describe('@all', () => {
    it('returns all terminals except sender', () => {
      const terminals = [makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')]
      const result = resolveGroupAddress('@all', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b', 'term_c'])
    })

    it('returns empty when sender is the only terminal', () => {
      const terminals = [makeSummary('term_a')]
      const result = resolveGroupAddress('@all', 'term_a', terminals, noStatus)
      expect(result).toEqual([])
    })
  })

  describe('@idle', () => {
    it('returns only idle terminals', () => {
      const terminals = [makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')]
      const getStatus = (h: string) => (h === 'term_b' ? 'idle' : 'busy')
      const result = resolveGroupAddress('@idle', 'term_a', terminals, getStatus)
      expect(result).toEqual(['term_b'])
    })

    it('excludes sender even if idle', () => {
      const terminals = [makeSummary('term_a'), makeSummary('term_b')]
      const getStatus = () => 'idle'
      const result = resolveGroupAddress('@idle', 'term_a', terminals, getStatus)
      expect(result).toEqual(['term_b'])
    })
  })

  describe('@worktree:<id>', () => {
    it('returns terminals in the specified worktree', () => {
      const terminals = [
        makeSummary('term_a', { worktreeId: 'wt_1' }),
        makeSummary('term_b', { worktreeId: 'wt_1' }),
        makeSummary('term_c', { worktreeId: 'wt_2' })
      ]
      const result = resolveGroupAddress('@worktree:wt_1', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })

    it('returns empty for nonexistent worktree', () => {
      const terminals = [makeSummary('term_a', { worktreeId: 'wt_1' })]
      const result = resolveGroupAddress('@worktree:wt_99', 'term_a', terminals, noStatus)
      expect(result).toEqual([])
    })
  })

  describe('agent name groups', () => {
    it('matches @claude by terminal title', () => {
      const terminals = [
        makeSummary('term_a', { title: 'Claude Code' }),
        makeSummary('term_b', { title: 'Claude Code' }),
        makeSummary('term_c', { title: 'Codex CLI' })
      ]
      const result = resolveGroupAddress('@claude', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })

    it('matches @mimo by terminal title', () => {
      const terminals = [
        makeSummary('term_a', { title: 'mimo' }),
        makeSummary('term_b', { title: 'MiMo Code session' }),
        makeSummary('term_c', { title: 'OpenCode' })
      ]
      const result = resolveGroupAddress('@mimo', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })

    it('matches @openclaude by terminal title', () => {
      const terminals = [
        makeSummary('term_a', { title: 'OpenClaude' }),
        makeSummary('term_b', { title: 'OpenClaude running' }),
        makeSummary('term_c', { title: 'Claude Code' })
      ]
      const result = resolveGroupAddress('@openclaude', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })

    it('does not match OpenClaude titles through @claude', () => {
      const terminals = [
        makeSummary('term_a', { title: 'Claude Code' }),
        makeSummary('term_b', { title: 'OpenClaude running' })
      ]
      const result = resolveGroupAddress('@claude', 'term_a', terminals, noStatus)
      expect(result).toEqual([])
    })

    it('matches @codex by terminal title', () => {
      const terminals = [
        makeSummary('term_a', { title: 'Codex CLI' }),
        makeSummary('term_b', { title: 'Codex CLI' })
      ]
      const result = resolveGroupAddress('@codex', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })

    it('matches @droid by terminal title and excludes sender', () => {
      const terminals = [
        makeSummary('term_a', { title: 'Droid ready' }),
        makeSummary('term_b', { title: 'Droid ready' }),
        makeSummary('term_c', { title: 'Droid - action required' })
      ]
      const result = resolveGroupAddress('@droid', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b', 'term_c'])
    })

    it('does not match Android, path, or hyphenated tokens through @droid', () => {
      const terminals = [
        makeSummary('term_a', { title: 'Codex CLI' }),
        makeSummary('term_b', { title: 'Android build' }),
        makeSummary('term_c', { title: '/tmp/android' }),
        makeSummary('term_d', { title: 'my-droid-worker' })
      ]
      const result = resolveGroupAddress('@droid', 'term_a', terminals, noStatus)
      expect(result).toEqual([])
    })

    it('is case-insensitive for group address', () => {
      const terminals = [makeSummary('term_a'), makeSummary('term_b', { title: 'Claude Code' })]
      const result = resolveGroupAddress('@Claude', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })
  })

  describe('unknown groups', () => {
    it('returns empty for unrecognized group', () => {
      const terminals = [makeSummary('term_a'), makeSummary('term_b')]
      const result = resolveGroupAddress('@unknown', 'term_a', terminals, noStatus)
      expect(result).toEqual([])
    })
  })
})
