import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTuiIdleRuntime } from './tui-idle-wait-test-harness'
import { waitForTranscriptIdle } from './agent-transcript-pane-test-harness'
import { registerBoundPty } from './bind-first-pane.test-fixture'
import { RuntimeMachineName } from './runtime-machine-name'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import type { OrcaRuntimeService } from './orca-runtime'
import type { TuiAgent } from '../../shared/tui-agent'

// #6011 follow-ups: apply wait evidence ranking to typing/delivery and allow unobserved output clocks on the open quiet lane.

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

async function makeRuntime(launchAgent: TuiAgent | null, foreground = 'codex') {
  const runtime = makeTuiIdleRuntime({
    repoPath: '/tmp/followups',
    getForegroundProcess: async () => foreground
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, GRAPH)
  registerBoundPty(runtime, PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: 'followups-inc',
    ...(launchAgent ? { agentLaunchAuthority: { launchToken: 'tok', launchAgent } } : {})
  })
  const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle }
}

/** Spy on actual delivery while running the real settlement gate. */
function watchDelivery(runtime: OrcaRuntimeService) {
  return vi
    .spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the delivery entry point is protected; the spy only needs its name and signature.
      runtime as never as { deliverPendingMessagesForLeaf: (leaf: unknown) => void },
      'deliverPendingMessagesForLeaf'
    )
    .mockImplementation(() => {})
}

// Fake time makes the 3s quiescence window deterministic under CI load.
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

    // Name-only Codex means idle for display even mid-turn; delivery must not type into that evidence alone.
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

  // Time can lift weak-evidence refusal without any further edge; delivery needs a retry to avoid stranded messages.
  it('retries a refused delivery once the pane falls quiet', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('\u280b Codex')}working\n`, Date.now())
    runtime.onPtyData(PTY_ID, `${osc('Codex')}output\n`, Date.now())
    expect(deliver).not.toHaveBeenCalled()

    // No further title/graph edge arrives after this daemon output stops.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deliver).toHaveBeenCalled()
  })

  it('does not retry into a pane that went busy again', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('Codex')}output\n`, Date.now())
    // Stream every 250ms of virtual time so no gap can accidentally exceed quiescence.
    for (let tick = 0; tick < 20; tick += 1) {
      runtime.onPtyData(PTY_ID, 'more output\n', Date.now())
      await vi.advanceTimersByTimeAsync(250)
    }
    expect(deliver).not.toHaveBeenCalled()
  })

  // A name-only frame consumes working-to-idle; later explicit readiness must still trigger delivery.
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

  // First-party done must re-offer delivery after working vetoed idle, without waiting for status expiry.
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
})

describe('quiescence treats a missing output clock as quiet', () => {
  it('settles a pane that has never produced output but holds a live agent process', async () => {
    const machineNameStart = vi
      .spyOn(RuntimeMachineName.prototype, 'start')
      .mockImplementation(() => {})
    try {
      // No launch metadata: Orca did not start this agent, so the quiet-foreground lane is
      // the only evidence available, and `lastOutputAt` is null because nothing ever arrived.
      const { runtime, handle } = await makeRuntime(null, 'codex')
      const leaves =
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reading the runtime's own leaf map to assert the precondition this test depends on.
        (runtime as never as { leaves: Map<string, { lastOutputAt: number | null }> }).leaves
      expect([...leaves.values()][0].lastOutputAt).toBeNull()

      await expect(waitForTranscriptIdle({ runtime, handle }, 8_000)).resolves.toMatchObject({
        condition: 'tui-idle',
        satisfied: true
      })
    } finally {
      machineNameStart.mockRestore()
    }
  }, 20_000)
})
