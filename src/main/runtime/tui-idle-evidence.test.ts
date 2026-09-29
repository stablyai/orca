import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from '../../shared/agent-title-status'
import { getSyntheticAgentTerminalTitle } from '../../shared/synthetic-agent-title'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { getTuiAgentRestSignal } from '../../shared/tui-agent-rest-signal'
import { isKnownReadyPromptBody } from './terminal-wait-detection'
import {
  evaluateTuiIdle,
  hasFreshDoneFirstPartyStatus,
  hasQuietReadyScreen,
  isTuiIdleReadyVerdict,
  nameOnlyIdleNeedsCorroboration,
  type TuiIdleEvaluationInput,
  type TuiIdleEvidenceRecord
} from './tui-idle-evidence'

const QUIESCENCE_MS = 3000

function record(overrides: Partial<TuiIdleEvidenceRecord> = {}): TuiIdleEvidenceRecord {
  return {
    lastAgentStatus: null,
    lastOutputAt: Date.now() - QUIESCENCE_MS * 2,
    lastOscTitle: 'tmp',
    ...overrides
  }
}

function input(overrides: Partial<TuiIdleEvaluationInput> = {}): TuiIdleEvaluationInput {
  return {
    record: record(),
    readTailBlockedReason: () => null,
    readPositiveBodyEvidence: () => false,
    readQuietReadyBodyEvidence: () => true,
    agent: 'muse',
    firstPartyStatus: null,
    quiescenceMs: QUIESCENCE_MS,
    ...overrides
  }
}

describe('hasQuietReadyScreen', () => {
  it('settles a Muse ready screen once the stream has gone quiet', () => {
    expect(hasQuietReadyScreen(record(), 'muse', () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('refuses while the pane is still streaming', () => {
    expect(
      hasQuietReadyScreen(record({ lastOutputAt: Date.now() }), 'muse', () => true, QUIESCENCE_MS)
    ).toBe(false)
  })

  it('refuses without an output clock, like the tier-3 lane', () => {
    expect(
      hasQuietReadyScreen(record({ lastOutputAt: null }), 'muse', () => true, QUIESCENCE_MS)
    ).toBe(false)
  })

  it('refuses without a ready screen', () => {
    expect(hasQuietReadyScreen(record(), 'muse', () => false, QUIESCENCE_MS)).toBe(false)
  })

  it('covers adopted panes that carry no launch metadata', () => {
    expect(hasQuietReadyScreen(record(), null, () => true, QUIESCENCE_MS)).toBe(true)
    expect(hasQuietReadyScreen(record(), undefined, () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('covers Codex, whose title carries no rest signal once idle', () => {
    expect(hasQuietReadyScreen(record(), 'codex', () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('refuses another agent quoting Muse or Codex in its scrollback', () => {
    expect(hasQuietReadyScreen(record(), 'claude', () => true, QUIESCENCE_MS)).toBe(false)
  })
})

describe('evaluateTuiIdle muse lane', () => {
  it('settles a quiet Muse pane with no title signal at all', () => {
    expect(evaluateTuiIdle(input())).toEqual({ kind: 'ready-strong' })
  })

  it('lets a fresh first-party working status veto the Muse body', () => {
    expect(
      evaluateTuiIdle(input({ firstPartyStatus: { state: 'working', updatedAt: Date.now() } }))
    ).toEqual({ kind: 'working' })
  })
})

describe('evaluateTuiIdle ranking', () => {
  const noMuse = { readQuietReadyBodyEvidence: () => false }

  it('ranks a blocking prompt in the tail above an explicit idle title', () => {
    const verdict = evaluateTuiIdle(
      input({
        ...noMuse,
        agent: 'claude',
        record: record({ lastAgentStatus: 'idle', lastOscTitle: '✳ Claude Code' }),
        readTailBlockedReason: () => 'agent-trust-workspace'
      })
    )
    expect(verdict).toEqual({ kind: 'blocked', reason: 'agent-trust-workspace' })
  })

  it("calls an agent's own idle title strong", () => {
    const verdict = evaluateTuiIdle(
      input({
        ...noMuse,
        agent: 'claude',
        record: record({ lastAgentStatus: 'idle', lastOscTitle: '✳ Claude Code' })
      })
    )
    expect(verdict).toEqual({ kind: 'ready-strong' })
  })

  it('calls a name-only title weak, even for an agent it is the only rest signal of', () => {
    const verdict = evaluateTuiIdle(
      input({ ...noMuse, agent: 'grok', record: record({ lastAgentStatus: 'idle' }) })
    )
    expect(verdict).toEqual({ kind: 'ready-weak' })
  })

  it("holds Claude's bare name to the quiet window, as an agent that announces rest itself", () => {
    const streaming = record({
      lastAgentStatus: 'idle',
      lastOscTitle: 'claude',
      lastOutputAt: Date.now()
    })
    expect(evaluateTuiIdle(input({ ...noMuse, agent: 'claude', record: streaming }))).toEqual({
      kind: 'pending',
      quietForeground: 'closed'
    })
    const quiet = record({ lastAgentStatus: 'idle', lastOscTitle: 'claude' })
    expect(evaluateTuiIdle(input({ ...noMuse, agent: 'claude', record: quiet }))).toEqual({
      kind: 'ready-weak'
    })
  })

  it('reads working, which suppresses the screen read, from a working title', () => {
    const verdict = evaluateTuiIdle(
      input({ ...noMuse, agent: 'claude', record: record({ lastAgentStatus: 'working' }) })
    )
    expect(verdict).toEqual({ kind: 'working' })
  })

  it('keeps a first-party blocked status pending, so the screen is still read', () => {
    const verdict = evaluateTuiIdle(
      input({
        ...noMuse,
        agent: null,
        record: record({ lastAgentStatus: 'idle', lastOscTitle: 'claude' }),
        firstPartyStatus: { state: 'blocked', updatedAt: Date.now() }
      })
    )
    expect(verdict).toEqual({ kind: 'pending', quietForeground: 'closed' })
  })

  it('leaves the quiet-foreground lane open for an unidentified pane with no title status', () => {
    expect(evaluateTuiIdle(input({ ...noMuse, agent: null }))).toEqual({
      kind: 'pending',
      quietForeground: 'open'
    })
  })

  it('closes the quiet-foreground lane for an agent with a stronger rest signal still to come', () => {
    for (const agent of ['claude', 'codex', 'grok', 'dsh'] as const) {
      expect(evaluateTuiIdle(input({ ...noMuse, agent }))).toEqual({
        kind: 'pending',
        quietForeground: 'closed'
      })
    }
  })

  // Why: a launched agent whose title Orca cannot classify has no other lane; closing this
  // one for every known agent left `worker start` failing at agent_readiness (STA-7440).
  it('keeps the quiet-foreground lane for an agent with no other rest signal, after it paints', () => {
    for (const agent of ['amp', 'goose', 'crush', 'kimi', 'qwen-code', 'rovo', 'aug'] as const) {
      expect(evaluateTuiIdle(input({ ...noMuse, agent }))).toEqual({
        kind: 'pending',
        quietForeground: 'after-paint'
      })
    }
  })

  it('closes the lane once any title has classified, so a title that does arrive outranks it', () => {
    const verdict = evaluateTuiIdle(
      input({ ...noMuse, agent: 'amp', record: record({ lastAgentStatus: 'permission' }) })
    )
    expect(verdict).toEqual({ kind: 'pending', quietForeground: 'closed' })
  })
})

// Why: `none` reopens the quiet-foreground lane, which is only safe where no stronger lane
// could have settled the wait; the identity-keyed lanes must agree with the declared signal.
describe('rest signal agrees with the lanes that can settle a wait', () => {
  it.each(Object.keys(TUI_AGENT_CONFIG).filter(isTuiAgent))('%s', (agent) => {
    const signal = getTuiAgentRestSignal(agent)
    const hookDone = hasFreshDoneFirstPartyStatus(agent, { state: 'done', updatedAt: Date.now() })
    expect(hookDone).toBe(signal === 'hook-done')
    let screenRead = false
    isKnownReadyPromptBody('', agent, () => {
      screenRead = true
      return null
    })
    const quietScreenBody = hasQuietReadyScreen(record(), agent, () => true, QUIESCENCE_MS)
    // Why not only ready-body: Codex keeps its stronger hook-driven title beside this lane.
    if (quietScreenBody) {
      expect(signal).not.toBe('none')
    }
    // Why a screen read also counts: Qoder's ready body is its composer, read by identity.
    if (signal === 'ready-body') {
      expect(quietScreenBody || screenRead).toBe(true)
    }
    if (signal !== 'none') {
      return
    }
    expect({
      screenRead,
      syntheticTitle: getSyntheticAgentTerminalTitle(agent, 'done'),
      processTitle: detectAgentStatusFromTitle(TUI_AGENT_CONFIG[agent].expectedProcess)
    }).toEqual({ screenRead: false, syntheticTitle: null, processTitle: null })
  })
})

describe('nameOnlyIdleNeedsCorroboration', () => {
  it('holds agents that announce rest with an explicit title, native or synthesized', () => {
    expect(nameOnlyIdleNeedsCorroboration('claude')).toBe(true)
    expect(nameOnlyIdleNeedsCorroboration('codex')).toBe(true)
  })

  it('exempts agents whose name is their only rest signal', () => {
    expect(nameOnlyIdleNeedsCorroboration('grok')).toBe(false)
  })

  it("names an adopted pane's agent from a shell auto-title", () => {
    expect(nameOnlyIdleNeedsCorroboration(null, 'claude')).toBe(true)
    expect(nameOnlyIdleNeedsCorroboration(null, 'claude ~/p/repo')).toBe(true)
  })
})

describe('a DSH pane settles tui-idle on its own hook', () => {
  const base = {
    record: { lastAgentStatus: null, lastOutputAt: null, lastOscTitle: '\u2726 \u{1F40B} repo' },
    rendererTitle: undefined,
    readPositiveBodyEvidence: () => false,
    readQuietReadyBodyEvidence: () => false,
    readTailBlockedReason: () => null,
    agent: 'dsh' as const,
    firstPartyStatus: { state: 'done' as const, updatedAt: Date.now() },
    quiescenceMs: 1_000
  } satisfies TuiIdleEvaluationInput

  const ready = (over: Partial<TuiIdleEvaluationInput> = {}) =>
    isTuiIdleReadyVerdict(evaluateTuiIdle({ ...base, ...over }))

  it('settles on a fresh first-party done', () => {
    // The regression: DSH's title carries no idle (its rest glyph is Gemini's working one),
    // so every title-reading tier failed and `terminal wait --for tui-idle` ran to timeout
    // against an already-ready composer.
    expect(ready()).toBe(true)
  })

  it('does not settle while the same pane reports working', () => {
    expect(ready({ firstPartyStatus: { state: 'working', updatedAt: Date.now() } })).toBe(false)
  })

  it('does not settle on a stale done', () => {
    expect(
      ready({ firstPartyStatus: { state: 'done', updatedAt: Date.now() - 31 * 60 * 1000 } })
    ).toBe(false)
  })

  it('leaves other agents on the title lanes', () => {
    // Scoped on purpose: an agent whose hooks report child turns can emit `done` mid-turn.
    expect(ready({ agent: 'claude' })).toBe(false)
  })
})
