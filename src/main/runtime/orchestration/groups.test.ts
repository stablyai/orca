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

    it('matches @grok as a standalone title token and excludes sender', () => {
      const terminals = [
        makeSummary('term_a', { title: 'Grok' }),
        makeSummary('term_b', { title: 'GROK CLI' }),
        makeSummary('term_c', { title: '⠋ Grok' }),
        makeSummary('term_d', { title: 'ngrok' }),
        makeSummary('term_e', { title: '/tmp/grok' }),
        makeSummary('term_f', { title: 'my-grok-worker' }),
        makeSummary('term_g', { title: 'Codex CLI' })
      ]

      const result = resolveGroupAddress('@GrOk', 'term_a', terminals, noStatus)

      expect(result).toEqual(['term_b', 'term_c'])
    })

    // Why: the resolver sees the raw OSC title, and Grok CLI's real working/session
    // titles carry a trailing " - grok" identity or a spinner-collapsed "⠋ grok"
    // (see terminal-title-agent-type.ts). Prove those production shapes resolve.
    it('matches real Grok OSC working and session titles', () => {
      const terminals = [
        makeSummary('coordinator', { title: 'Coordinator' }),
        makeSummary('term_rotating', { title: '⠋ - fix the flaky suite - grok' }),
        makeSummary('term_collapsed', { title: '⠋ grok' }),
        makeSummary('term_session', { title: 'Fix the auth bug - grok' })
      ]

      const result = resolveGroupAddress('@grok', 'coordinator', terminals, noStatus)

      expect(result).toEqual(['term_rotating', 'term_collapsed', 'term_session'])
    })

    // Why: Windows agent titles can surface the launcher process name (`grok.exe`);
    // the shared matcher accepts .exe/.cmd/.bat/.ps1 suffixes but still rejects
    // arbitrary dotted fragments like `grok.py`.
    it('matches Windows launcher-suffix titles but not arbitrary dotted tokens', () => {
      const terminals = [
        makeSummary('coordinator', { title: 'Coordinator' }),
        makeSummary('term_exe', { title: 'grok.exe' }),
        makeSummary('term_cmd', { title: 'grok.cmd running' }),
        makeSummary('term_dotted', { title: 'grok.py' })
      ]

      const result = resolveGroupAddress('@grok', 'coordinator', terminals, noStatus)

      expect(result).toEqual(['term_exe', 'term_cmd'])
    })

    // Why: these are the titles cursor-agent natively emits and the ones Orca synthesizes
    // from Cursor hooks, so each must resolve.
    it('matches native and Orca-synthesized Cursor titles', () => {
      const terminals = [
        makeSummary('coordinator', { title: 'Coordinator' }),
        makeSummary('term_native', { title: 'Cursor Agent' }),
        makeSummary('term_working', { title: '⠋ Cursor Agent' }),
        makeSummary('term_idle', { title: 'Cursor ready' }),
        makeSummary('term_permission', { title: 'Cursor - action required' })
      ]

      const result = resolveGroupAddress('@cursor', 'coordinator', terminals, noStatus)

      expect(result).toEqual(['term_native', 'term_working', 'term_idle', 'term_permission'])
    })

    it('is case-insensitive for @cursor', () => {
      const terminals = [
        makeSummary('coordinator', { title: 'Coordinator' }),
        makeSummary('term_b', { title: 'CURSOR READY' })
      ]

      const result = resolveGroupAddress('@CuRsOr', 'coordinator', terminals, noStatus)

      expect(result).toEqual(['term_b'])
    })

    // Why: this is the false positive that a whole-token matcher cannot catch. Claude
    // and Codex put their task summary in the OSC title, and none of Claude's status
    // prefixes carries its own name, so "cursor" as ordinary editor vocabulary is the
    // only agent token such a title has. Routing @cursor there would write into a live
    // non-Cursor agent's prompt.
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

    // Why: pin the deliberate tradeoff. A renamed Cursor pane outranks its OSC title, so it
    // is group-unaddressable and resolves to nothing instead of resolving loosely. A silent
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
