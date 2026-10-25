import { describe, expect, it } from 'vitest'
import {
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isKnownReadyPromptPreview,
  isKnownReadyPromptSettled
} from '../terminal-wait-detection'
import { nameOnlyIdleNeedsCorroboration } from '../tui-idle-evidence'
import {
  compileAgentRules,
  evaluateCompiledRules,
  readsTrustedScreen,
  type AgentStateRegions
} from './agent-state-rules-engine'
import { parseAgentStateRuleFiles } from './agent-state-rules-catalog'
import { showsIdleTitleAnchor } from './agent-state-title-anchors'

const STRONG_QUIET = { state: 'idle', strength: 'strong', requiresQuiet: true }
const TITLE = { region: 'title', status: 'idle' }

function rule(id: string, when: Record<string, unknown>, answer: Record<string, unknown>) {
  return { id, why: 'test', priority: 100, when, answer }
}

const READY_ANCHOR = {
  id: 'ready',
  why: 'test',
  when: { region: 'text', find: { lastOf: 'ready>' } },
  answer: { state: 'idle' }
}

function file(rules: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'codex', engineVersion: 1, anchors: [READY_ANCHOR], rules, ...extra }
}

function evaluate(rules: unknown[], regions: AgentStateRegions): string | null {
  const [parsed] = parseAgentStateRuleFiles([file(rules, { profile: { screenSource: 'live' } })])
  return evaluateCompiledRules(compileAgentRules(parsed), regions)?.ruleId ?? null
}

describe('region schema', () => {
  const screen = { region: 'screen', predicate: 'codex-composer-ready' }

  it.each([
    [
      'screen rows beside a predicate',
      file([rule('a', { ...screen, rows: [{ contains: '>' }] }, STRONG_QUIET)], {
        profile: { screenSource: 'live' }
      })
    ],
    ['screen rules with no screenSource', file([rule('a', screen, STRONG_QUIET)])],
    [
      'withoutClock on a weak rule',
      file([
        rule(
          'a',
          { region: 'title', status: 'idle' },
          { state: 'idle', strength: 'weak', requiresQuiet: true, withoutClock: 'skip' }
        )
      ])
    ],
    [
      'a text rule naming no anchor of its file',
      file([rule('a', { region: 'text', anchor: 'missing' }, STRONG_QUIET)])
    ],
    [
      'a text rule naming a non-idle anchor',
      file([rule('a', { region: 'text', anchor: 'live' }, STRONG_QUIET)], {
        anchors: [{ ...READY_ANCHOR, id: 'live', answer: { state: 'live' } }]
      })
    ],
    [
      'a title anchor answering other than idle',
      file([], {
        anchors: [
          {
            id: 't',
            why: 'test',
            when: { region: 'title', match: { contains: '◇' } },
            answer: { state: 'live' }
          }
        ]
      })
    ],
    [
      'a title rule on a status other than idle',
      file([rule('a', { region: 'title', status: 'working' }, STRONG_QUIET)])
    ],
    ['an unknown pane id', { ...file([]), id: 'unknown' }],
    ['two anchors with one id', file([], { anchors: [READY_ANCHOR, READY_ANCHOR] })],
    [
      'two rules with one id',
      file([rule('a', TITLE, STRONG_QUIET), rule('a', TITLE, STRONG_QUIET)])
    ]
  ])('rejects %s', (_label, candidate) => {
    expect(() => parseAgentStateRuleFiles([candidate])).toThrow()
  })

  it('accepts the unknown-pane file', () => {
    expect(() => parseAgentStateRuleFiles([{ ...file([]), id: 'unknown-pane' }])).not.toThrow()
  })
})

describe('regions', () => {
  const title = rule('title', { region: 'title', status: 'idle' }, STRONG_QUIET)
  const text = rule('text', { region: 'text', anchor: 'ready' }, STRONG_QUIET)

  it('skips a rule whose region the lane does not read', () => {
    expect(evaluate([title], { readScreenLines: () => [] })).toBeNull()
    expect(evaluate([title], { readTitleStatus: () => 'idle' })).toBe('title')
    expect(evaluate([title], { readTitleStatus: () => 'working' })).toBeNull()
  })

  it('reads a named screen predicate over the lowercased screen', () => {
    const composer = rule(
      'c',
      { region: 'screen', predicate: 'codex-composer-ready' },
      STRONG_QUIET
    )
    expect(evaluate([composer], { readScreenLines: () => ['› Ask Codex to do anything'] })).toBe(
      'c'
    )
    expect(
      evaluate([composer], {
        readScreenLines: () => ['esc to interrupt)', '› Ask Codex to do anything']
      })
    ).toBeNull()
  })

  it('needs its text anchor settled: no blocker painted after it', () => {
    const readText = (value: string) => ({ readText: () => value })
    expect(evaluate([text], readText('ready>'))).toBe('text')
    expect(evaluate([text], readText('ready>\ndo you trust this folder?'))).toBeNull()
    expect(evaluate([text], readText('do you trust this folder?\nready>'))).toBe('text')
  })

  it('skips a rule marked withoutClock skip only on a pane with no output clock', () => {
    const skipped = rule(
      's',
      { region: 'title', status: 'idle' },
      { ...STRONG_QUIET, withoutClock: 'skip' }
    )
    const regions = { readTitleStatus: () => 'idle' as const }
    expect(evaluate([skipped, title], { ...regions, hasOutputClock: true })).toBe('s')
    expect(evaluate([skipped, title], { ...regions, hasOutputClock: false })).toBe('title')
  })
})

describe('the bundled Codex text anchors', () => {
  const header =
    '╭───╮\n│ >_ openai codex (v0.157.0) │\n│ model: gpt-5 │\n│ directory: ~/repo │\n╰───╯'

  it('settles on the loaded header, and takes the header as proof a dialog was answered', () => {
    expect(isKnownReadyPromptSettled(header)).toBe(true)
    expect(
      detectTerminalWaitBlockedReason(
        'do you trust this folder?\n1. yes\n>_ openai codex (v0.158.0)'
      )
    ).toBeNull()
  })

  it('holds a provisional header: present, but not yet taking input', () => {
    const provisional = header.replace('gpt-5', 'loading')
    expect(isKnownReadyPromptPreview(provisional)).toBe(true)
    expect(isKnownReadyPromptSettled(provisional)).toBe(false)
    expect(isKnownReadyPromptSettled(`${provisional}\n› hi\ngpt-5 · ~/repo`)).toBe(true)
  })

  it('holds its own ready text to quiet on a clocked Codex pane, and believes it clockless', () => {
    expect(isKnownReadyPromptBody(header, 'codex', () => null, true)).toBe(false)
    expect(isKnownReadyPromptBody(header, 'codex', () => null, false)).toBe(true)
    expect(isKnownReadyPromptBody(header, 'claude', () => null, true)).toBe(true)
  })

  it("takes no other agent's ready text on a clocked Codex pane, as before the rule files", () => {
    const cursorPrompt = '>_ openai codex (v0.158.0)\ncursor agent\n→'
    expect(isKnownReadyPromptBody(cursorPrompt, 'codex', () => null, true)).toBe(false)
    expect(isKnownReadyPromptBody(cursorPrompt, 'codex', () => null, false)).toBe(true)
    expect(isKnownReadyPromptBody(cursorPrompt, 'claude', () => null, true)).toBe(true)
  })

  it('settles an unknown pane on the live-screen Codex header at once, even clocked', () => {
    const screen = () => header.split('\n')
    expect(isKnownReadyPromptBody('', null, screen, true)).toBe(true)
    expect(isKnownReadyPromptBody('', 'claude', screen, true)).toBe(false)
  })

  it('reads the live screen for Codex, not the trusted grid', () => {
    expect(readsTrustedScreen('codex')).toBe(false)
    expect(readsTrustedScreen('cline')).toBe(true)
  })
})

describe('the bundled title anchors', () => {
  it.each(['✳ Claude Code', '* Claude Code', '◇  Ready (repo)', 'π - orca', 'OC | orca'])(
    'reads %s as an explicit idle title',
    (title) => {
      expect(detectExplicitIdleStatusFromTitle(title)).toBe('idle')
    }
  )

  it('marks an agent rest title only when an anchor matches it', () => {
    expect(showsIdleTitleAnchor('✳ Claude Code')).toBe(true)
    expect(showsIdleTitleAnchor('Claude Code')).toBe(false)
  })

  it('leaves a name-only title to the agent idle-title rule', () => {
    expect(detectExplicitIdleStatusFromTitle('claude')).toBeNull()
    expect(nameOnlyIdleNeedsCorroboration('pi')).toBe(true)
    expect(nameOnlyIdleNeedsCorroboration('omp')).toBe(true)
    expect(nameOnlyIdleNeedsCorroboration('gemini')).toBe(false)
    expect(nameOnlyIdleNeedsCorroboration('opencode')).toBe(false)
  })
})
