import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTuiIdleRuntime } from './tui-idle-wait-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import type { OrcaRuntimeService } from './orca-runtime'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

// Follow-ons to #6011. The evidence ranking that fixed the wait path did not reach two
// other consumers of the same signal: mailbox delivery, which TYPES INTO the pane, and
// the idle poll's quiescence gate, which read a missing output clock as "never quiet".

const WORKTREE_ID = 'repo-1::/tmp/followups'
const TAB_ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const LEAF_ID = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'
const PTY_ID = 'pty-followups'
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const osc = (title: string) => `${ESC}]0;${title}${BEL}`
const agentStatus = (state: string, agentType: string) =>
  `${ESC}]9999;{"state":"${state}","agentType":"${agentType}"}${BEL}`

const GRAPH: RuntimeSyncWindowGraph = {
  tabs: [
    { tabId: TAB_ID, worktreeId: WORKTREE_ID, title: 'Agent', activeLeafId: LEAF_ID, layout: null }
  ],
  leaves: [
    {
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneRuntimeId: 1,
      ptyId: PTY_ID,
      paneTitle: null,
      title: ''
    }
  ]
}

async function makeRuntime(
  launchAgent: TuiAgent | null,
  foreground = 'codex',
  hookRows?: () => AgentStatusIpcPayload[]
) {
  const runtime = makeTuiIdleRuntime({
    repoPath: '/tmp/followups',
    getForegroundProcess: async () => foreground,
    getAgentStatusSnapshot: hookRows
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, GRAPH)
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: 'followups-inc',
    ...(launchAgent ? { agentLaunchAuthority: { launchToken: 'tok', launchAgent } } : {})
  })
  const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle }
}

/** Counts real delivery attempts. Spies on the delivery entry point, NOT on the gate
 *  under test — the gate runs for real and decides whether this is ever reached. */
function watchDelivery(runtime: OrcaRuntimeService) {
  return vi
    .spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the delivery entry point is protected; the spy only needs its name and signature.
      runtime as never as { deliverPendingMessagesForLeaf: (leaf: unknown) => void },
      'deliverPendingMessagesForLeaf'
    )
    .mockImplementation(() => {})
}

// Why fake timers: the retry fires on a real 3s quiescence window, and asserting around it
// with wall-clock sleeps made the result depend on how promptly a loaded CI runner schedules
// an interval. The clock is the thing under test, so it has to be the deterministic part.
describe('mailbox delivery honours the tui-idle evidence ranking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not deliver into a pane that is only showing its agent name mid-turn', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('⠋ Codex')}working\n`, Date.now())
    expect(deliver).not.toHaveBeenCalled()

    // The busy agent repaints its title to the bare product name. That reads as `idle`
    // for display, but it is emitted just as often mid-turn — typing into the pane here
    // injects the pointer plus Enter into a running turn.
    runtime.onPtyData(PTY_ID, `${osc('Codex')}still working\n`, Date.now())
    expect(deliver).not.toHaveBeenCalled()
  })

  it('delivers once the agent states it is done', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('⠋ Codex')}working\n`, Date.now())
    runtime.onPtyData(PTY_ID, `${osc('Codex ready')}done\n`, Date.now())
    expect(deliver).toHaveBeenCalled()
  })

  // Why this case exists: the wait path POLLS, so weak evidence that only becomes valid
  // with time eventually satisfies it. Delivery is edge-driven with no poll behind it, so a
  // refusal at an edge is final unless another edge arrives. A hookless Codex never emits an
  // explicit `X ready`, so without a retry the queued message strands permanently once the
  // pane falls quiet — trading a visible mis-delivery for an invisible lost message.
  it('retries a refused delivery once the pane falls quiet', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('\u280b Codex')}working\n`, Date.now())
    runtime.onPtyData(PTY_ID, `${osc('Codex')}output\n`, Date.now())
    expect(deliver).not.toHaveBeenCalled()

    // Output stops. No further title frame and no renderer graph sync — a daemon-hosted
    // pane has nobody publishing one, so nothing re-fires an edge on its own.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deliver).toHaveBeenCalled()
  })

  it('does not retry into a pane that went busy again', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('Codex')}output\n`, Date.now())
    // Keep the stream alive across the whole retry window.
    // Deterministic streaming: one chunk every 250ms of virtual time, so the gap between
    // chunks can never drift past the quiescence window the way a real interval can.
    for (let tick = 0; tick < 20; tick += 1) {
      runtime.onPtyData(PTY_ID, 'more output\n', Date.now())
      await vi.advanceTimersByTimeAsync(250)
    }
    expect(deliver).not.toHaveBeenCalled()
  })

  // Case B, the mainline path: a hooked Codex emits a name-only frame BEFORE the hook's
  // `Codex ready`. The name-only frame consumes the working->idle transition, leaving the
  // ready title as an idle->idle step that delivery was never offered — so the strongest
  // evidence the agent ever emits could not reach it.
  it('delivers when the ready title arrives after a name-only frame', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('\u280b Codex')}working\n`, Date.now())
    runtime.onPtyData(PTY_ID, `${osc('Codex')}out\n`, Date.now())
    expect(deliver).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    runtime.onPtyData(PTY_ID, osc('Codex ready'), Date.now())
    // Promptly, on the ready title itself — not after waiting out a quiescence window.
    expect(deliver).toHaveBeenCalled()
  })

  // Case C: the agent's own status stream vetoes the idle title, then reports done with no
  // edge behind it. `working` stays fresh for 30 minutes, so without a re-offer the veto
  // outlives the turn it described.
  it('delivers when a done status lands after the idle title was vetoed', async () => {
    const { runtime } = await makeRuntime('claude')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(
      PTY_ID,
      `${agentStatus('working', 'claude')}${osc('\u280b Claude')}w\n`,
      Date.now()
    )
    runtime.onPtyData(PTY_ID, `${osc('claude')}out\n`, Date.now())
    expect(deliver).not.toHaveBeenCalled()

    runtime.onPtyData(PTY_ID, agentStatus('done', 'claude'), Date.now())
    await vi.advanceTimersByTimeAsync(4_500)
    expect(deliver).toHaveBeenCalled()
  })

  it('still delivers for an agent whose name is its only rest signal', async () => {
    const { runtime } = await makeRuntime('grok', 'grok')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('⠋ Grok')}working\n`, Date.now())
    runtime.onPtyData(PTY_ID, `${osc('grok')}banner\n`, Date.now())
    expect(deliver).toHaveBeenCalled()
  })

  it('does not deliver into a pane when Claude is waiting on an interactive question', async () => {
    let hookRows: AgentStatusIpcPayload[] = [
      {
        paneKey: makePaneKey(TAB_ID, LEAF_ID),
        connectionId: null,
        state: 'waiting',
        agentType: 'claude',
        toolName: 'AskUserQuestion',
        interactivePrompt: JSON.stringify({
          questions: [{ question: 'Which branch to use?', options: ['main', 'develop'] }]
        }),
        prompt: 'Which branch to use?',
        receivedAt: Date.now(),
        stateStartedAt: Date.now()
      }
    ]
    const { runtime } = await makeRuntime('claude', 'claude', () => hookRows)
    const deliver = watchDelivery(runtime)

    // Claude repaints its title to name or ready while rendering the prompt question.
    runtime.onPtyData(PTY_ID, `${osc('Claude')}\n`, Date.now())
    expect(deliver).not.toHaveBeenCalled()

    // Even after long quiescence, delivery remains parked while the question is pending.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deliver).not.toHaveBeenCalled()

    // Once user answers the question, hook reports done and delivery unblocks.
    hookRows = [
      {
        ...hookRows[0],
        state: 'done',
        toolName: undefined,
        interactivePrompt: undefined,
        receivedAt: Date.now()
      }
    ]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deliver).toHaveBeenCalled()
  })
})

describe('quiescence treats a missing output clock as quiet', () => {
  it('settles a pane that has never produced output but holds a live agent process', async () => {
    // No launch metadata: Orca did not start this agent, so the quiet-foreground lane is
    // the only evidence available, and `lastOutputAt` is null because nothing ever arrived.
    const { runtime, handle } = await makeRuntime(null, 'codex')
    const leaves =
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reading the runtime's own leaf map to assert the precondition this test depends on.
      (runtime as never as { leaves: Map<string, { lastOutputAt: number | null }> }).leaves
    expect([...leaves.values()][0].lastOutputAt).toBeNull()

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 8_000 })
    ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
  }, 20_000)
})
