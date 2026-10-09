import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from '../../shared/agent-title-status'
import { getSyntheticAgentTerminalTitle } from '../../shared/synthetic-agent-title'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { getTuiAgentRestSignal } from '../../shared/tui-agent-rest-signal'
import { isKnownReadyPromptBody } from './terminal-wait-detection'
import {
  evaluateAgentStateRules,
  hookAuthority,
  readsTrustedScreen
} from './agent-state-rules/agent-state-rules-engine'
import {
  evaluateTuiIdle,
  quietForegroundLaneForTerminalAgent,
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
    readAgentRuleVerdict: () => null,
    readScreenInputVeto: () => null,
    titleObservedAtEpochMs: null,
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
  it('leaves the lane open for recognized dsb instead of reading a missing launch config', () => {
    expect(quietForegroundLaneForTerminalAgent('dsb')).toBe('open')
    expect(quietForegroundLaneForTerminalAgent('codex')).toBe('closed')
  })

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
    // Why both ways: a `hook-done` agent rests only through the hook lane, and a trusted hook
    // lane is a stronger signal than the quiet foreground `none` reopens.
    const trustsHooks = hookAuthority(agent) !== 'identity-only'
    if (signal === 'hook-done') {
      expect(trustsHooks).toBe(true)
    }
    if (trustsHooks) {
      expect(signal).not.toBe('none')
    }
    let screenRead = false
    isKnownReadyPromptBody(
      '',
      agent,
      () => {
        screenRead = true
        return null
      },
      false
    )
    const quietScreenBody = hasQuietReadyScreen(record(), agent, () => true, QUIESCENCE_MS)
    // Why a screen-ruled `none` is sound: its screen shuts the quiet lane whenever one is readable.
    if (readsTrustedScreen(agent)) {
      const refused = ['> not an idle composer']
      const ruled = (screen: readonly string[] | null) =>
        evaluateAgentStateRules(agent, { readScreenLines: () => screen })
      expect(ruled(refused)?.state).toBe('hold')
      const verdict = (screen: readonly string[] | null) =>
        evaluateTuiIdle(
          input({
            agent,
            record: record({ lastOscTitle: null }),
            readQuietReadyBodyEvidence: () => false,
            readAgentRuleVerdict: () => ruled(screen)
          })
        )
      expect(verdict(refused)).toEqual({ kind: 'pending', quietForeground: 'closed' })
      expect(verdict(null)).toEqual({
        kind: 'pending',
        quietForeground: signal === 'none' ? 'after-paint' : 'closed'
      })
      return
    }
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
  it('keeps recognition-only DSB titles outside managed idle-title policies', () => {
    expect(nameOnlyIdleNeedsCorroboration(null, 'DeepSeek Build')).toBe(false)
  })

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

describe('evaluateTuiIdle screen input veto', () => {
  const omp = (overrides: Partial<TuiIdleEvaluationInput> = {}) =>
    input({ agent: 'omp', readQuietReadyBodyEvidence: () => false, ...overrides })

  it('refuses every ready lane while the screen vetoes input', () => {
    const lanes: Partial<TuiIdleEvaluationInput>[] = [
      { record: record({ lastOscTitle: 'π - repo', lastAgentStatus: 'idle' }) },
      { readPositiveBodyEvidence: () => true },
      { firstPartyStatus: { state: 'done', updatedAt: Date.now(), sessionBoundary: true } },
      { record: record({ lastOscTitle: 'OMP', lastAgentStatus: 'idle' }) }
    ]
    for (const lane of lanes) {
      expect(isTuiIdleReadyVerdict(evaluateTuiIdle(omp(lane)))).toBe(true)
      expect(evaluateTuiIdle(omp({ ...lane, readScreenInputVeto: () => true }))).toEqual({
        kind: 'pending',
        quietForeground: 'closed'
      })
    }
  })

  it("accepts OMP's own idle title once it has stood on a screen read clear of the wizard", () => {
    const idle = {
      record: record({
        lastOscTitle: 'π > repo',
        lastAgentStatus: 'idle',
        lastOutputAt: Date.now()
      }),
      titleObservedAtEpochMs: Date.now() - QUIESCENCE_MS
    }
    // Output still flowing (OMP's bracketed-paste keepalive) does not hold the title back.
    expect(evaluateTuiIdle(omp({ ...idle, readScreenInputVeto: () => false }))).toEqual({
      kind: 'ready-strong'
    })
    for (const unproven of [
      { readScreenInputVeto: () => null },
      { readScreenInputVeto: () => true },
      {
        titleObservedAtEpochMs: Date.now() - QUIESCENCE_MS + 1_000,
        readScreenInputVeto: () => false
      },
      { titleObservedAtEpochMs: null, readScreenInputVeto: () => false }
    ]) {
      expect(isTuiIdleReadyVerdict(evaluateTuiIdle(omp({ ...idle, ...unproven })))).toBe(false)
    }
  })

  it('keeps an OMP pane waiting on the user pending, so the poll still reads its screen', () => {
    expect(
      evaluateTuiIdle(
        omp({
          record: record({ lastOscTitle: 'OMP', lastAgentStatus: 'idle' }),
          firstPartyStatus: { state: 'blocked', updatedAt: Date.now() }
        })
      )
    ).toEqual({ kind: 'pending', quietForeground: 'closed' })
  })
})
