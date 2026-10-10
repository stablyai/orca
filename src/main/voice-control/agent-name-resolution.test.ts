import { describe, expect, it } from 'vitest'
import type { VoiceRosterEntry } from './voice-control-roster'
import { canonicalizeSpokenName, resolveAgentBySpokenName } from './agent-name-resolution'

function entry(spokenName: string): VoiceRosterEntry {
  return {
    spokenName,
    worktreeId: `w-${spokenName}`,
    repoId: 'repo-1',
    paneKey: `p-${spokenName}`,
    agentType: 'claude',
    state: 'working',
    taskTitle: null,
    toolName: null,
    worktreePath: '/tmp/x',
    hostId: null
  }
}

describe('canonicalizeSpokenName', () => {
  it.each([
    ['oak!', 'oak'],
    ['fix-login', 'fix login'],
    ['oak two', 'oak 2'],
    ['  The   Fix  Login ', 'the fix login'],
    ['agent twenty', 'agent 20'],
    ['oak to', 'oak to']
  ])('%s → %s', (input, expected) => {
    expect(canonicalizeSpokenName(input)).toBe(expected)
  })
})

describe('resolveAgentBySpokenName', () => {
  it.each([
    {
      name: 'exact match wins outright',
      spoken: 'fix login',
      roster: ['fix login', 'fix tests'],
      expect: { kind: 'resolved', spokenName: 'fix login' }
    },
    {
      name: 'case and punctuation are noise',
      spoken: 'Fix-Login.',
      roster: ['fix login'],
      expect: { kind: 'resolved', spokenName: 'fix login' }
    },
    {
      name: 'number words match dedup suffixes',
      spoken: 'oak two',
      roster: ['oak', 'oak 2'],
      expect: { kind: 'resolved', spokenName: 'oak 2' }
    },
    {
      name: 'bare name with a numeric sibling still resolves to the exact match',
      spoken: 'oak',
      roster: ['oak', 'oak 2'],
      expect: { kind: 'resolved', spokenName: 'oak' }
    },
    {
      name: 'filler words around the name resolve by containment',
      spoken: 'the fix login agent',
      roster: ['fix login', 'billing'],
      expect: { kind: 'resolved', spokenName: 'fix login' }
    },
    {
      name: 'kebab-case display names match spaced speech',
      spoken: 'growth ops apps',
      roster: ['growth-ops-apps'],
      expect: { kind: 'resolved', spokenName: 'growth-ops-apps' }
    },
    {
      name: 'a one-edit typo resolves by Levenshtein',
      spoken: 'oakwod',
      roster: ['oakwood', 'billing'],
      expect: { kind: 'resolved', spokenName: 'oakwood' }
    },
    {
      name: 'a distant typo does not',
      spoken: 'xylophone',
      roster: ['oak', 'billing'],
      expect: { kind: 'unresolved' }
    },
    {
      name: 'empty speech is unresolved',
      spoken: '   ',
      roster: ['oak'],
      expect: { kind: 'unresolved' }
    },
    {
      name: 'an empty roster is unresolved',
      spoken: 'oak',
      roster: [],
      expect: { kind: 'unresolved' }
    }
  ])('$name', ({ spoken, roster, expect: expected }) => {
    const resolution = resolveAgentBySpokenName(spoken, roster.map(entry))
    if (expected.kind === 'resolved') {
      expect(resolution).toMatchObject({
        kind: 'resolved',
        entry: { spokenName: expected.spokenName }
      })
    } else {
      expect(resolution).toEqual({ kind: 'unresolved' })
    }
  })

  it('returns the contenders when a prefix matches two agents', () => {
    const resolution = resolveAgentBySpokenName('fix', [entry('fix login'), entry('fix tests')])
    expect(resolution.kind).toBe('ambiguous')
    if (resolution.kind === 'ambiguous') {
      expect(resolution.candidates.map((c) => c.spokenName).sort()).toEqual([
        'fix login',
        'fix tests'
      ])
    }
  })

  it('caps ambiguity candidates at three', () => {
    const resolution = resolveAgentBySpokenName('agent', [
      entry('agent alpha'),
      entry('agent beta'),
      entry('agent gamma'),
      entry('agent delta')
    ])
    expect(resolution.kind).toBe('ambiguous')
    if (resolution.kind === 'ambiguous') {
      expect(resolution.candidates).toHaveLength(3)
    }
  })

  it('an exact match is never reported ambiguous', () => {
    const resolution = resolveAgentBySpokenName('billing', [
      entry('billing'),
      entry('billing service')
    ])
    expect(resolution).toMatchObject({ kind: 'resolved', entry: { spokenName: 'billing' } })
  })
})
