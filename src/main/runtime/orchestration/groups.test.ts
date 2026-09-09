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
    // Why spread and not a default: `agentIdentity` absent is meaningful (unknown), so the
    // helper must be able to produce a summary that genuinely lacks the field.
    ...(opts.agentIdentity ? { agentIdentity: opts.agentIdentity } : {})
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
    // Why identity and not title: these groups used to match `@<name>` against the terminal
    // title, so any pane whose task text mentioned an agent received that agent's messages.
    // Routing now reads the identity the host resolved from launch/process evidence it owns.

    it('routes to every pane the host resolved as that agent', () => {
      const terminals = [
        makeSummary('term_a', { agentIdentity: 'claude' }),
        makeSummary('term_b', { agentIdentity: 'claude' }),
        makeSummary('term_c', { agentIdentity: 'codex' })
      ]
      expect(resolveGroupAddress('@claude', 'term_a', terminals, noStatus)).toEqual(['term_b'])
    })

    it.each([
      ['@codex', 'codex'],
      ['@openclaude', 'openclaude'],
      ['@mimo', 'mimo-code'],
      ['@gemini', 'gemini'],
      ['@droid', 'droid'],
      ['@grok', 'grok'],
      ['@cursor', 'cursor'],
      ['@opencode', 'opencode']
    ])('routes %s to its agent id', (group, agentIdentity) => {
      const terminals = [
        makeSummary('sender'),
        makeSummary('target', { agentIdentity: agentIdentity as never }),
        makeSummary('other', { agentIdentity: 'claude' })
      ]
      const expected = agentIdentity === 'claude' ? ['target', 'other'] : ['target']
      expect(resolveGroupAddress(group, 'sender', terminals, noStatus)).toEqual(expected)
    })

    it('is case-insensitive for the group address', () => {
      const terminals = [makeSummary('sender'), makeSummary('target', { agentIdentity: 'claude' })]
      expect(resolveGroupAddress('@CLAUDE', 'sender', terminals, noStatus)).toEqual(['target'])
    })

    it('excludes the sender even when the sender is that agent', () => {
      const terminals = [
        makeSummary('sender', { agentIdentity: 'grok' }),
        makeSummary('target', { agentIdentity: 'grok' })
      ]
      expect(resolveGroupAddress('@grok', 'sender', terminals, noStatus)).toEqual(['target'])
    })

    describe('a task title can no longer redirect a message', () => {
      // The bug. Recorded titles of this exact shape exist: a Grok pane named
      // "Switch Claude and Codex off the load balancer… - grok" received both @claude and @codex.
      it('does not route @claude to a Codex pane whose task text names Claude', () => {
        const terminals = [
          makeSummary('sender'),
          makeSummary('codex_pane', {
            agentIdentity: 'codex',
            title: 'Review the Claude session-history fix'
          })
        ]
        expect(resolveGroupAddress('@claude', 'sender', terminals, noStatus)).toEqual([])
      })

      it('does not route @codex to a Grok pane whose task text names Codex', () => {
        const terminals = [
          makeSummary('sender'),
          makeSummary('grok_pane', {
            agentIdentity: 'grok',
            title: 'Switch Claude and Codex off the load balancer… - grok'
          })
        ]
        expect(resolveGroupAddress('@codex', 'sender', terminals, noStatus)).toEqual([])
        expect(resolveGroupAddress('@grok', 'sender', terminals, noStatus)).toEqual(['grok_pane'])
      })

      it('does not route @cursor to a pane merely discussing a text cursor', () => {
        const terminals = [
          makeSummary('sender'),
          makeSummary('claude_pane', {
            agentIdentity: 'claude',
            title: 'fix the text cursor blink'
          })
        ]
        expect(resolveGroupAddress('@cursor', 'sender', terminals, noStatus)).toEqual([])
      })
    })

    describe('unknown identity fails closed', () => {
      // Why: `agentIdentity` is absent when the host predates the field or had no evidence
      // beyond the title. Delivery is an action, so unknown must not deliver. The sender sees
      // no recipients, which is visible and recoverable; a message in the wrong agent's prompt
      // is neither.
      it('does not route to a pane with no resolved identity, whatever its title says', () => {
        const terminals = [makeSummary('sender'), makeSummary('unknown', { title: 'Claude Code' })]
        expect(resolveGroupAddress('@claude', 'sender', terminals, noStatus)).toEqual([])
      })

      it('still routes the identity-free groups, which do not depend on the field', () => {
        const terminals = [makeSummary('sender'), makeSummary('other', { title: 'Claude Code' })]
        expect(resolveGroupAddress('@all', 'sender', terminals, noStatus)).toEqual(['other'])
      })
    })

    it('returns no recipients for an unknown group', () => {
      const terminals = [makeSummary('sender'), makeSummary('target', { agentIdentity: 'claude' })]
      expect(resolveGroupAddress('@nonsense', 'sender', terminals, noStatus)).toEqual([])
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
