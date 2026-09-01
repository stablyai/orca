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
    preview: opts.preview ?? '',
    ...(opts.requestedAgent !== undefined ? { requestedAgent: opts.requestedAgent } : {}),
    ...(opts.baseAgent !== undefined ? { baseAgent: opts.baseAgent } : {})
  }
}

const noStatus = () => null

describe('isGroupAddress', () => {
  it('returns true for @-prefixed addresses', () => {
    expect(isGroupAddress('@all')).toBe(true)
    expect(isGroupAddress('@idle')).toBe(true)
    expect(isGroupAddress('@claude')).toBe(true)
    expect(isGroupAddress('@droid')).toBe(true)
    expect(isGroupAddress('@grok')).toBe(true)
    expect(isGroupAddress('@cursor')).toBe(true)
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
    it('matches @claude by validated base attribution, not title', () => {
      const terminals = [
        makeSummary('term_a', { baseAgent: 'claude' }),
        makeSummary('term_b', { baseAgent: 'claude' }),
        makeSummary('term_c', { baseAgent: 'codex' })
      ]
      const result = resolveGroupAddress('@claude', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })

    it('maps the mimo-code base to the @mimo group', () => {
      const terminals = [
        makeSummary('term_a', { baseAgent: 'mimo-code' }),
        makeSummary('term_b', { baseAgent: 'mimo-code' }),
        makeSummary('term_c', { baseAgent: 'opencode' })
      ]
      const result = resolveGroupAddress('@mimo', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })

    it('a custom agent joins its base harness group', () => {
      // The summary builder resolves a custom requestedAgent to its base; the
      // custom terminal is addressable under the base group.
      const terminals = [
        makeSummary('term_a', { baseAgent: 'claude' }),
        makeSummary('term_b', {
          requestedAgent: 'custom-agent:claude:01234567-89ab-4cde-8f01-23456789abcd',
          baseAgent: 'claude'
        })
      ]
      const result = resolveGroupAddress('@claude', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })

    it('keeps openclaude and claude as distinct groups', () => {
      const terminals = [
        makeSummary('term_a', { baseAgent: 'claude' }),
        makeSummary('term_b', { baseAgent: 'openclaude' })
      ]
      expect(resolveGroupAddress('@claude', 'term_a', terminals, noStatus)).toEqual([])
      expect(resolveGroupAddress('@openclaude', 'term_a', terminals, noStatus)).toEqual(['term_b'])
    })

    it('omits an unattributed terminal rather than guessing from its title', () => {
      // A title that reads like an agent name must NOT join the group without
      // validated base attribution (U6 coordinator terminals rely on this).
      const terminals = [
        makeSummary('term_a', { baseAgent: 'claude' }),
        makeSummary('term_b', { title: 'Claude Code' })
      ]
      const result = resolveGroupAddress('@claude', 'term_a', terminals, noStatus)
      expect(result).toEqual([])
    })

    it('matches @droid by base and excludes the sender', () => {
      const terminals = [
        makeSummary('term_a', { baseAgent: 'droid' }),
        makeSummary('term_b', { baseAgent: 'droid' }),
        makeSummary('term_c', { baseAgent: 'droid' })
      ]
      const result = resolveGroupAddress('@droid', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b', 'term_c'])
    })

    it('does not map bases without an addressable group', () => {
      // 'autohand' has no agent-name group; it is unreachable via base groups.
      const terminals = [
        makeSummary('term_a', { baseAgent: 'claude' }),
        makeSummary('term_b', { baseAgent: 'autohand' })
      ]
      expect(resolveGroupAddress('@claude', 'term_a', terminals, noStatus)).toEqual([])
    })

    it('is case-insensitive for the group address', () => {
      const terminals = [
        makeSummary('term_a', { baseAgent: 'codex' }),
        makeSummary('term_b', { baseAgent: 'claude' })
      ]
      const result = resolveGroupAddress('@Claude', 'term_a', terminals, noStatus)
      expect(result).toEqual(['term_b'])
    })

    it('matches @grok by validated base, excludes sender, and ignores grok-like titles', () => {
      const terminals = [
        makeSummary('term_a', { baseAgent: 'grok' }),
        makeSummary('term_b', { baseAgent: 'grok' }),
        makeSummary('term_c', { baseAgent: 'grok', title: '⠋ Grok' }),
        makeSummary('term_d', { title: 'ngrok' }),
        makeSummary('term_e', { title: 'GROK CLI' }),
        makeSummary('term_g', { baseAgent: 'codex' })
      ]

      const result = resolveGroupAddress('@GrOk', 'term_a', terminals, noStatus)

      expect(result).toEqual(['term_b', 'term_c'])
    })

    it('matches @cursor by validated base regardless of title shape', () => {
      const terminals = [
        makeSummary('coordinator', { baseAgent: 'claude' }),
        makeSummary('term_native', { baseAgent: 'cursor', title: 'Cursor Agent' }),
        makeSummary('term_working', { baseAgent: 'cursor', title: '⠋ Cursor Agent' }),
        makeSummary('term_renamed', { baseAgent: 'cursor', title: 'reviewer pane' }),
        makeSummary('term_title_only', { title: 'Cursor - action required' })
      ]

      const result = resolveGroupAddress('@cursor', 'coordinator', terminals, noStatus)

      expect(result).toEqual(['term_native', 'term_working', 'term_renamed'])
    })

    it('is case-insensitive for @cursor', () => {
      const terminals = [
        makeSummary('coordinator', { baseAgent: 'claude' }),
        makeSummary('term_b', { baseAgent: 'cursor' })
      ]

      const result = resolveGroupAddress('@CuRsOr', 'coordinator', terminals, noStatus)

      expect(result).toEqual(['term_b'])
    })

    // Why: "cursor" is ordinary editor vocabulary in other agents' task-summary
    // titles. Base-only resolution must never route @cursor into a live
    // non-Cursor agent's prompt no matter what the title says.
    it('does not match another agent whose task title mentions a text cursor', () => {
      const terminals = [
        makeSummary('coordinator', { title: 'Coordinator' }),
        makeSummary('term_claude_working', {
          title: '⠋ preserve cursor visibility across replays'
        }),
        makeSummary('term_claude_idle', { title: '✳ Fix the text cursor blink' }),
        makeSummary('term_claude_dot', { title: '. fix cursor position' }),
        makeSummary('term_claude_star', { title: '* cursor rendering done' }),
        makeSummary('term_codex', { title: '⠋ Codex: fix cursor offsets' }),
        makeSummary('term_grok', { title: '⠋ - restoring cursor state - grok' }),
        makeSummary('term_shell', { title: 'Terminal Cursor and Orca slows down' })
      ]

      const result = resolveGroupAddress('@cursor', 'coordinator', terminals, noStatus)

      expect(result).toEqual([])
    })

    // Why: pin the deliberate tradeoff. Cursor-looking titles without validated
    // base attribution resolve to nothing instead of resolving loosely. A silent
    // miss (address it by handle) is preferred over delivering into another agent's prompt.
    it('does not match a renamed Cursor terminal or the bare process name', () => {
      const terminals = [
        makeSummary('coordinator', { title: 'Coordinator' }),
        makeSummary('term_renamed', { title: 'Cursor - reviewer' }),
        makeSummary('term_worker', { title: 'cursor worker 2' }),
        makeSummary('term_process', { title: 'cursor-agent' })
      ]

      const result = resolveGroupAddress('@cursor', 'coordinator', terminals, noStatus)

      expect(result).toEqual([])
    })

    it('does not match cursor paths, hyphenated compounds, or dotted tokens', () => {
      const terminals = [
        makeSummary('coordinator', { title: 'Coordinator' }),
        makeSummary('term_rules', { title: '~/cursor-rules' }),
        makeSummary('term_path', { title: '/tmp/cursor' }),
        makeSummary('term_worker', { title: 'my-cursor-worker' }),
        makeSummary('term_file', { title: 'render-cursor-after-bracketed-paste' }),
        makeSummary('term_dotted', { title: 'cursor.ts' })
      ]

      const result = resolveGroupAddress('@cursor', 'coordinator', terminals, noStatus)

      expect(result).toEqual([])
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
