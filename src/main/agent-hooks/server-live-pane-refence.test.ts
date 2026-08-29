import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

/** Each source's new-turn boundary (arms the fence from a retired pane), its session-start
 *  boundary if it has one, and a follow-up event that is neither. `sessionStart: null` names a
 *  source that emits no session boundary at all — those are re-fenced by the spawn path, never by
 *  an event. `armable: false` names a source no new-turn event can un-retire, so nothing can fence
 *  its pane in the first place and nothing can strand it.
 *  Why a Record over the source union: a new source fails typecheck here instead of silently
 *  skipping coverage. */
const BOUNDARIES: Record<
  AgentHookSource,
  { newTurn: string; sessionStart: string | null; followUp?: string; armable?: false }
> = {
  claude: { newTurn: 'UserPromptSubmit', sessionStart: 'SessionStart' },
  // Why null: Kimi's names are Claude-compatible, but `normalizeKimiEvent` has no SessionStart
  // case and `KIMI_HOOK_EVENTS` does not subscribe to one, so no kimi session boundary can reach
  // the fence. The spawn path is the only thing that re-fences a kimi pane.
  kimi: { newTurn: 'UserPromptSubmit', sessionStart: null },
  codex: { newTurn: 'UserPromptSubmit', sessionStart: 'SessionStart' },
  gemini: { newTurn: 'BeforeAgent', sessionStart: null },
  antigravity: { newTurn: 'PreInvocation', sessionStart: null },
  amp: { newTurn: 'agent.start', sessionStart: 'session.start' },
  cursor: { newTurn: 'beforeSubmitPrompt', sessionStart: 'sessionStart' },
  pi: { newTurn: 'before_agent_start', sessionStart: 'session_start' },
  omp: { newTurn: 'before_agent_start', sessionStart: null },
  'prime-agent': { newTurn: 'before_agent_start', sessionStart: 'session_start' },
  droid: { newTurn: 'UserPromptSubmit', sessionStart: 'SessionStart' },
  grok: { newTurn: 'user_prompt_submit', sessionStart: 'session_start' },
  copilot: { newTurn: 'UserPromptSubmit', sessionStart: 'sessionStart' },
  hermes: { newTurn: 'pre_llm_call', sessionStart: 'on_session_start' },
  devin: { newTurn: 'UserPromptSubmit', sessionStart: 'SessionStart' },
  opencode: { newTurn: 'SessionStart', sessionStart: 'SessionStart', followUp: 'SessionBusy' },
  'mimo-code': { newTurn: 'MessagePart', sessionStart: null },
  // Why armable: false — Command Code names no new-turn boundary either, so a retired pane of its
  // never comes back and never mints a fence. Nothing here can strand it.
  'command-code': { newTurn: 'PreToolUse', sessionStart: null, armable: false }
}

function post(
  server: AgentHookServer,
  source: AgentHookSource,
  hookEventName: string,
  launchToken: string,
  prompt: string,
  options: { isReplay?: boolean } = {}
): void {
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source,
      hookEventName,
      launchToken,
      ...(options.isReplay === true ? { isReplay: true } : {}),
      ...(source === 'mimo-code' ? { hasExplicitPrompt: true } : {}),
      payload: {
        state: 'working',
        prompt,
        agentType: source,
        ...(source === 'mimo-code' ? { role: 'user', text: prompt } : {})
      }
    },
    'conn-1'
  )
}

function promptOf(server: AgentHookServer): string | undefined {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)?.prompt
}

/** Retire the pane, then let a tokened new turn revive it — that revive is what mints the
 *  launch-token fence this suite is about. */
function armFence(server: AgentHookServer, source: AgentHookSource, token: string): void {
  server.retirePaneAuthority(PANE)
  post(server, source, BOUNDARIES[source].newTurn, token, 'first turn')
  expect(promptOf(server)).toBe('first turn')
}

const SOURCES = (Object.keys(BOUNDARIES) as AgentHookSource[]).filter(
  (source) => BOUNDARIES[source].armable !== false
)
const WITH_SESSION_START = SOURCES.filter((source) => BOUNDARIES[source].sessionStart !== null)

describe("a fenced live pane re-fences on each provider's own session boundary", () => {
  // Why the whole matrix: the branch matched the literal `SessionStart`, which only 5 of the 18
  // sources send. Every other source's replacement process was suppressed forever, with no
  // user-reachable way to bring the pane's row back.
  it.each(WITH_SESSION_START)('%s', (source) => {
    const server = new AgentHookServer()
    armFence(server, source, 'token-1')

    const sessionStart = BOUNDARIES[source].sessionStart as string
    post(server, source, sessionStart, 'token-2', 'session start')
    post(server, source, BOUNDARIES[source].newTurn, 'token-2', 'second turn')

    expect(promptOf(server)).toBe('second turn')
  })

  it.each(WITH_SESSION_START)('%s still fences the token it replaced', (source) => {
    const server = new AgentHookServer()
    armFence(server, source, 'token-1')

    post(server, source, BOUNDARIES[source].sessionStart as string, 'token-2', 'session start')
    post(server, source, BOUNDARIES[source].newTurn, 'token-2', 'second turn')
    // The process the fence replaced is still alive and still posting; it must not win the row.
    // Why followUp and not the boundary: a boundary event IS the proof a process just started,
    // so replaying one would be asking the gate to distrust its own evidence.
    post(
      server,
      source,
      BOUNDARIES[source].followUp ?? BOUNDARIES[source].newTurn,
      'token-1',
      'stale turn'
    )

    expect(promptOf(server)).toBe('second turn')
  })
})

describe('a fenced live pane re-fences on the spawn that replaced its process', () => {
  // Why every armable source and not only the ones with no session boundary: the spawn
  // notification is provider-independent by construction, and it is what actually rescues the
  // sources whose session boundary Orca never installs (cursor) or never normalizes (kimi).
  // Scoping this to the no-boundary bucket left those two covered only by an event production
  // never sends.
  it.each(SOURCES)('%s', (source) => {
    const server = new AgentHookServer()
    armFence(server, source, 'token-1')

    server.noteAgentPaneLaunchToken(PANE, 'token-2')
    post(server, source, BOUNDARIES[source].newTurn, 'token-2', 'second turn')

    expect(promptOf(server)).toBe('second turn')
  })

  it('does not leave a tokenless respawn fenced to the process it replaced', () => {
    const server = new AgentHookServer()
    armFence(server, 'gemini', 'token-1')

    // Why: nothing in a replacement PTY that carries no token can ever satisfy the old one, so
    // keeping the fence would only ever admit the process the spawn replaced. (The tokenless
    // poster itself is governed by the unmanaged-extension fence, which holds provisionally.)
    server.noteAgentPaneLaunchToken(PANE, undefined)
    post(server, 'gemini', 'BeforeAgent', 'token-2', 'second turn')

    expect(promptOf(server)).toBe('second turn')
  })

  it('does not arm a fence on a pane that never had one', () => {
    const server = new AgentHookServer()
    server.noteAgentPaneLaunchToken(PANE, 'token-1')
    // Why: arming here would start suppressing tokenless posters in panes no revive ever fenced.
    post(server, 'gemini', 'BeforeAgent', '', 'tokenless turn')

    expect(promptOf(server)).toBe('tokenless turn')
  })
})

describe("relay spool replay is fenced on the pane's current generation", () => {
  // Why: the replay fence compared against the last token main happened to observe. An agent
  // launched over SSH whose connection dropped before its first live post had every spooled
  // event — including its final one — discarded as if it were the stale generation.
  it('accepts a replay from the generation the pane was last launched with', () => {
    const server = new AgentHookServer()
    post(server, 'claude', 'UserPromptSubmit', 'token-a', 'agent a')
    expect(promptOf(server)).toBe('agent a')

    server.noteAgentPaneLaunchToken(PANE, 'token-b')
    post(server, 'claude', 'UserPromptSubmit', 'token-b', 'agent b offline', { isReplay: true })

    expect(promptOf(server)).toBe('agent b offline')
  })

  it('still discards a replay from the generation that spawn replaced', () => {
    const server = new AgentHookServer()
    post(server, 'claude', 'UserPromptSubmit', 'token-a', 'agent a')
    server.noteAgentPaneLaunchToken(PANE, 'token-b')
    post(server, 'claude', 'UserPromptSubmit', 'token-b', 'agent b offline', { isReplay: true })

    post(server, 'claude', 'UserPromptSubmit', 'token-a', 'agent a late spool', { isReplay: true })

    expect(promptOf(server)).toBe('agent b offline')
  })

  it('keeps the spool of a poster whose process never received the token', () => {
    // Why: every shell-side poster emits `${ORCA_AGENT_LAUNCH_TOKEN:-}`, so a process that never
    // got the variable reports an EMPTY token, not an absent one. On the WSL and SSH launch paths
    // the variable can be lost in transit (WSLENV passthrough, sshd's accepted env), so this is a
    // real remote population — and before the spawn notification existed such a pane had no
    // expectation at all and its spool landed. Rejecting it here would recreate, for that
    // population, the exact silent frozen row this fence is supposed to prevent.
    const server = new AgentHookServer()
    server.noteAgentPaneLaunchToken(PANE, 'token-b')

    post(server, 'claude', 'UserPromptSubmit', '', 'offline agent finished', { isReplay: true })

    expect(promptOf(server)).toBe('offline agent finished')
  })

  it('keeps the spool of a pane whose later launch minted no token', () => {
    // Why this is the reachable shape and not a contrivance: `orca-runtime.ts` mints a launch
    // token only when a `launchConfig` is present, so an ordinary relaunch into an
    // already-tokened pane is untokened. Its posts are tokenless, its spool is tokenless, and
    // the expectation the first launch armed is deliberately never cleared by a tokenless one.
    const server = new AgentHookServer()
    server.noteAgentPaneLaunchToken(PANE, 'token-a')
    server.noteAgentPaneLaunchToken(PANE, undefined)

    post(server, 'claude', 'UserPromptSubmit', '', 'untokened relaunch finished', {
      isReplay: true
    })

    expect(promptOf(server)).toBe('untokened relaunch finished')
  })

  it('does not clear the expectation when a tokenless shell respawns into the pane', () => {
    // Why: the expectation is only ever RAISED. A shell launched with no agent token is not
    // evidence about any generation, so it must not open the pane to the generation the last
    // real launch replaced.
    const server = new AgentHookServer()
    post(server, 'claude', 'UserPromptSubmit', 'token-a', 'agent a')
    server.noteAgentPaneLaunchToken(PANE, undefined)

    post(server, 'claude', 'UserPromptSubmit', 'token-old', 'older generation spool', {
      isReplay: true
    })

    expect(promptOf(server)).toBe('agent a')
  })

  it('admits the generation the standing expectation names after a tokenless respawn', () => {
    // Positive control for the test above: the expectation survives, it does not reject
    // everything. Same setup, a replay that names the generation the expectation stands for.
    const server = new AgentHookServer()
    post(server, 'claude', 'UserPromptSubmit', 'token-a', 'agent a')
    server.noteAgentPaneLaunchToken(PANE, undefined)

    post(server, 'claude', 'UserPromptSubmit', 'token-a', 'agent a offline', { isReplay: true })

    expect(promptOf(server)).toBe('agent a offline')
  })
})
