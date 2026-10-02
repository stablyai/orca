import { describe, expect, it } from 'vitest'
import { evaluateTuiIdle, type TuiIdleEvaluationInput } from '../tui-idle-evidence'
import { isKnownReadyPromptBody, isQuietReadyScreenBody } from '../terminal-wait-detection'
import {
  compileAgentRules,
  evaluateAgentStateRules,
  evaluateCompiledRules,
  type AgentStateVerdict
} from './agent-state-rules-engine'
import { parseAgentStateRuleFiles } from './agent-state-rules-catalog'

const QUIESCENCE_MS = 3000

function anchor(when: Record<string, unknown>, answer: Record<string, unknown>) {
  return { id: 'anchor', why: 'test', when, answer }
}

type RuleFileOverrides = { rules?: unknown[]; anchors?: unknown[] } & Record<string, unknown>

function ruleFile(overrides: RuleFileOverrides = {}): Record<string, unknown> {
  return {
    id: 'cline',
    engineVersion: 1,
    profile: { screenSource: 'trusted' },
    anchors: [],
    rules: [],
    ...overrides
  }
}

const SCREEN = { region: 'screen' }

function idleRule(id: string, priority: number, rows: unknown[]): Record<string, unknown> {
  return {
    id,
    why: 'test',
    priority,
    when: { ...SCREEN, rows },
    answer: { state: 'idle', strength: 'strong', requiresQuiet: true }
  }
}

const HOLD = { id: 'hold', why: 'test', priority: 100, when: SCREEN, answer: { state: 'hold' } }

function evaluate(rules: unknown[], screen: readonly string[] | null): string | null {
  const [file] = parseAgentStateRuleFiles([ruleFile({ rules })])
  return (
    evaluateCompiledRules(compileAgentRules(file), { readScreenLines: () => screen })?.ruleId ??
    null
  )
}

describe('agent state rules schema', () => {
  it.each([
    ['an unknown field', ruleFile({ fallback: 'quiet' })],
    ['an unknown agent', ruleFile({ id: 'not-an-agent' })],
    ['another engine version', ruleFile({ engineVersion: 2 })],
    ['a misspelled rule field', ruleFile({ rules: [{ ...HOLD, requireQuiet: true }] })],
    ['a rule with no why', ruleFile({ rules: [{ ...HOLD, why: undefined }] })],
    [
      'row modifiers with no rows',
      ruleFile({ rules: [{ ...HOLD, when: { ...SCREEN, endsWithinBottom: 2 } }] })
    ],
    ['a pattern that does not compile', ruleFile({ rules: [idleRule('a', 1, [{ regex: '(' }])] })],
    [
      'an optional last row',
      ruleFile({ rules: [idleRule('a', 1, [{ optional: { contains: '>' } }])] })
    ],
    [
      'a codex-only blocked reason',
      ruleFile({
        anchors: [
          anchor(
            { region: 'text', find: { lastOf: 'update' } },
            { state: 'blocked', reason: 'codex-update-prompt' }
          )
        ]
      })
    ],
    [
      'an unregistered named anchor',
      ruleFile({
        anchors: [anchor({ region: 'text', find: { predicate: 'nope' } }, { state: 'idle' })]
      })
    ],
    [
      'a blocked anchor the prefilter cannot key on',
      ruleFile({
        anchors: [
          anchor(
            { region: 'text', find: { predicate: 'antigravity-text-composer' } },
            { state: 'blocked', reason: 'agent-approval-prompt' }
          )
        ]
      })
    ],
    [
      'an uppercase anchor literal, which the lowercased tail never contains',
      ruleFile({
        anchors: [anchor({ region: 'text', find: { lastOf: 'Cursor' } }, { state: 'idle' })]
      })
    ],
    [
      'an uppercase anchor contains term',
      ruleFile({
        anchors: [
          anchor(
            { region: 'text', find: { lastOf: 'x' }, after: { contains: 'Run' } },
            { state: 'idle' }
          )
        ]
      })
    ]
  ])('rejects %s', (_label, file) => {
    expect(() => parseAgentStateRuleFiles([file])).toThrow()
  })

  it('rejects two files for one agent', () => {
    expect(() => parseAgentStateRuleFiles([ruleFile(), ruleFile()])).toThrow(/two files/)
  })

  const withPattern = (regex: string) => ruleFile({ rules: [idleRule('a', 1, [{ regex }])] })

  it.each([
    ['a backreference', '(a)\\1'],
    ['a lookbehind', '(?<=a)b'],
    ['nested quantifiers', '(a+)+$'],
    ['a repeated optional', '(a?)*$'],
    ['a repeated alternation', '(?:a|aa)+$'],
    ['a variable group nested in a repeated one', '(?:x(?:a|b))+']
  ])('rejects %s', (_label, regex) => {
    expect(() => parseAgentStateRuleFiles([withPattern(regex)])).toThrow(/pattern/)
  })

  it.each([
    ['a repeated fixed group', '(?: or [a-z])*'],
    ['an unrepeated alternation holding a repeat', '\\((?:tab|esc(?: or [a-z])*)\\)$'],
    ['an optional alternation', '^(?:yes|no)?$']
  ])('accepts %s', (_label, regex) => {
    expect(() => parseAgentStateRuleFiles([withPattern(regex)])).not.toThrow()
  })
})

describe('priority evaluation', () => {
  const ready = idleRule('ready', 500, [{ regex: '^>$' }])

  it('answers with the highest-priority match whatever the file order', () => {
    expect(evaluate([HOLD, ready], ['>'])).toBe('ready')
    expect(evaluate([HOLD, ready], ['busy'])).toBe('hold')
  })

  it('breaks priority ties by file order', () => {
    const tiedHold = { ...HOLD, priority: 500 }
    expect(evaluate([tiedHold, ready], ['>'])).toBe('hold')
    expect(evaluate([ready, tiedHold], ['>'])).toBe('ready')
  })

  it('gives no answer without a readable screen, so the caller decides', () => {
    expect(evaluate([ready, HOLD], null)).toBeNull()
  })

  it('gives no answer when nothing matches and there is no hold', () => {
    expect(evaluate([ready], ['busy'])).toBeNull()
  })
})

describe('screen rows', () => {
  const block = (match: Record<string, unknown>) => [
    { ...HOLD, id: 'm', when: { ...SCREEN, ...match } }
  ]

  it('reads rows above the screen as empty', () => {
    const rows = [{ none: [{ contains: '⠋' }] }, { regex: '^>$' }]
    expect(evaluate(block({ rows }), ['>'])).toBe('m')
    expect(evaluate(block({ rows: [{ regex: '^─+$' }, { regex: '^>$' }] }), ['>'])).toBeNull()
  })

  it('skips an optional row that does not match', () => {
    const rows = [{ regex: '^top$' }, { optional: { contains: 'hint' } }, { regex: '^>$' }]
    expect(evaluate(block({ rows }), ['top', 'hint', '>'])).toBe('m')
    expect(evaluate(block({ rows }), ['top', '>'])).toBe('m')
    expect(evaluate(block({ rows }), ['other', '>'])).toBeNull()
  })

  it('ends the block at the lowest match within endsWithinBottom', () => {
    const rows = [{ regex: '^─+$' }, { regex: '^mode$' }]
    expect(evaluate(block({ rows, endsWithinBottom: 2 }), ['───', 'mode', 'cwd'])).toBe('m')
    expect(evaluate(block({ rows, endsWithinBottom: 1 }), ['───', 'mode', 'cwd'])).toBeNull()
  })

  it('vetoes a block when a row above it matches noneAbove', () => {
    const match = { rows: [{ regex: '^>$' }], noneAbove: { contains: '⠋' } }
    expect(evaluate(block(match), ['⠋ thinking', '>'])).toBeNull()
    expect(evaluate(block(match), ['done', '>'])).toBe('m')
  })

  it('combines all, any and none on one row', () => {
    const rows = [{ all: [{ regex: '\\)$' }], any: [{ contains: 'yes' }, { contains: 'no' }] }]
    expect(evaluate(block({ rows }), ['yes (y)'])).toBe('m')
    expect(evaluate(block({ rows }), ['maybe (m)'])).toBeNull()
  })
})

describe('strength and quiet through the tui-idle ranking', () => {
  const now = Date.now()

  function verdictFor(ruled: AgentStateVerdict, lastOutputAt: number | null): string {
    const input: TuiIdleEvaluationInput = {
      record: { lastAgentStatus: null, lastOutputAt, lastOscTitle: null },
      readTailBlockedReason: () => null,
      readPositiveBodyEvidence: () => false,
      readQuietReadyBodyEvidence: () => false,
      readAgentRuleVerdict: () => ruled,
      agent: 'cline',
      firstPartyStatus: null,
      quiescenceMs: QUIESCENCE_MS
    }
    const verdict = evaluateTuiIdle(input)
    return verdict.kind === 'pending' ? `pending:${verdict.quietForeground}` : verdict.kind
  }

  const weak = (requiresQuiet: boolean): AgentStateVerdict => ({
    ruleId: 'w',
    state: 'idle',
    strength: 'weak',
    requiresQuiet
  })

  it('settles weak idle only on the weak lane, and only once quiet when it asks to', () => {
    expect(verdictFor(weak(false), now)).toBe('ready-weak')
    expect(verdictFor(weak(true), now)).toBe('pending:closed')
    expect(verdictFor(weak(true), now - QUIESCENCE_MS)).toBe('ready-weak')
    expect(verdictFor(weak(true), null)).toBe('pending:closed')
  })

  it('holds every weak lane on a hold', () => {
    expect(verdictFor({ ruleId: 'h', state: 'hold' }, now - QUIESCENCE_MS)).toBe('pending:closed')
  })
})

describe('a bundled strong, quiet idle rule', () => {
  // Antigravity's idle composer (agent-state-rules/antigravity.json).
  const readyScreen = ['─'.repeat(20), '>', '─'.repeat(20), '? for shortcuts']

  it('is believed at once on a pane with no output clock', () => {
    expect(isKnownReadyPromptBody('', 'antigravity', () => readyScreen, false)).toBe(true)
  })

  it('waits for quiet on a clocked pane', () => {
    expect(isKnownReadyPromptBody('', 'antigravity', () => readyScreen, true)).toBe(false)
    expect(isQuietReadyScreenBody('', 'antigravity', () => readyScreen)).toBe(true)
  })

  it('holds when the screen shows something else', () => {
    const picker = [...readyScreen.slice(0, 3), 'esc to cancel']
    expect(evaluateAgentStateRules('antigravity', { readScreenLines: () => picker })?.state).toBe(
      'hold'
    )
  })
})
