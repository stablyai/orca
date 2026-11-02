/** Return runtime-minted paneKey because a client renderer cannot resolve main-side term_* handles. Identity crosses the wire; placement stays with the client. */

import { describe, expect, it, vi } from 'vitest'
import { isAgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { RpcContext } from '../core'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub as RuntimeStub
} from './agent-launch.test-fixture'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async () => ({
    ok: true,
    value: { sessionId: 'sess-1' }
  })
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

/** Shaped like a pane the runtime really mints: `randomUUID()` for the tab and for the leaf. */
const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

/** Settings with no structured preference, so every launch here settles as a terminal. */
const TERMINAL_ONLY = {}

async function launch(params: unknown, runtime: RuntimeStub, context: Partial<RpcContext> = {}) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, { ...CAPABLE_CLIENT, ...context }))
}

const EXISTING_LAUNCH = {
  agent: 'claude',
  target: { kind: 'existing', worktree: 'id:wt-7' }
}

describe('the pane a terminal launch created', () => {
  it('reports the pane key the runtime minted', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalPaneKey: PANE_KEY })

    const result = await launch(EXISTING_LAUNCH, runtime)

    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1', paneKey: PANE_KEY })
  })

  it('carries the pane key through a downgrade to a terminal', async () => {
    // The downgrade builds its terminal through the same factory, so it must not lose identity
    // the outright-terminal path keeps.
    const runtime = runtimeStub({
      createSupport: { supported: false, reason: 'wsl' },
      terminalPaneKey: PANE_KEY
    })

    const result = await launch(EXISTING_LAUNCH, runtime)

    expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'wsl_execution_runtime' })
    expect(result.outcome).toMatchObject({ kind: 'terminal', paneKey: PANE_KEY })
  })

  it('omits the pane key when the runtime reported none', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    const result = await launch(EXISTING_LAUNCH, runtime)

    // Absent, not empty: a client must be able to tell "no pane to adopt" from "a pane called ''".
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1' })
  })

  it('omits the pane key for a reused terminal, which this launch did not create', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalPaneKey: PANE_KEY })

    const result = await launch(
      { ...EXISTING_LAUNCH, reuseTerminal: { handle: 'term_live' } },
      runtime
    )

    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_live' })
  })

  it('reports the pane key for a worktree-create startup terminal', async () => {
    const runtime = runtimeStub({
      settings: TERMINAL_ONLY,
      startupTerminalPaneKey: PANE_KEY
    })

    const result = await launch(
      {
        agent: 'claude',
        target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
      },
      runtime
    )

    expect(result.outcome).toEqual({
      kind: 'terminal',
      handle: 'term_agent_first',
      paneKey: PANE_KEY
    })
  })

  it.each([undefined, ''])(
    'omits an absent or empty startup-terminal pane key (%s)',
    async (startupTerminalPaneKey) => {
      const runtime = runtimeStub({ settings: TERMINAL_ONLY, startupTerminalPaneKey })

      const result = await launch(
        {
          agent: 'claude',
          target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
        },
        runtime
      )

      expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_agent_first' })
    }
  )
})

describe('reading a recorded launch back', () => {
  // Replay uses this guard; missing validation leaks unchecked fields, over-validation rejects recorded answers.
  const BASE = {
    worktreeId: 'wt-7',
    receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'ok' }
  }

  it('accepts a row carrying a pane key', () => {
    expect(
      isAgentLaunchResult({
        ...BASE,
        outcome: { kind: 'terminal', handle: 't', paneKey: PANE_KEY }
      })
    ).toBe(true)
  })

  it('accepts a row written before the field existed', () => {
    expect(isAgentLaunchResult({ ...BASE, outcome: { kind: 'terminal', handle: 't' } })).toBe(true)
  })

  it('refuses a row whose pane key is not a string', () => {
    expect(
      isAgentLaunchResult({ ...BASE, outcome: { kind: 'terminal', handle: 't', paneKey: 7 } })
    ).toBe(false)
  })

  it("checks a structured row's tab id when present and reads one written without it", () => {
    const structured = { kind: 'structured', handle: 'h', sessionId: 'sess-1' }
    expect(isAgentLaunchResult({ ...BASE, outcome: structured })).toBe(true)
    expect(isAgentLaunchResult({ ...BASE, outcome: { ...structured, tabId: TAB_ID } })).toBe(true)
    expect(isAgentLaunchResult({ ...BASE, outcome: { ...structured, tabId: 7 } })).toBe(false)
  })
})
