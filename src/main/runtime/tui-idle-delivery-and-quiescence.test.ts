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
    .spyOn(runtime['orchestrationMailboxNotifications'], 'deliverForTerminal')
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

  // Agents queue or steer text typed mid-turn, so a busy pane takes mail without waiting for rest.
  it('delivers into a pane mid-turn', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('⠋ Codex')}working\n`, Date.now())
    expect(deliver).toHaveBeenCalled()
  })

  it('does not deliver into a name-only pane that has not gone quiet', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    // Name-only Codex is weak idle evidence, which a shell auto-title can also write before the TUI mounts.
    runtime.onPtyData(PTY_ID, `${osc('Codex')}output\n`, Date.now())
    expect(deliver).not.toHaveBeenCalled()
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

  // A name-only frame consumes the idle edge; later explicit readiness must still trigger delivery.
  it('delivers when the ready title arrives after a name-only frame', async () => {
    const { runtime } = await makeRuntime('codex')
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('Codex')}out\n`, Date.now())
    expect(deliver).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    runtime.onPtyData(PTY_ID, osc('Codex ready'), Date.now())
    // Promptly, on the ready title itself — not after waiting out a quiescence window.
    expect(deliver).toHaveBeenCalled()
  })

  // A recognized terminal agent outside the readiness-rule set still queues mid-turn text.
  it('delivers mid-turn into a recognized foreground dsb pane', async () => {
    const { runtime } = await makeRuntime(null, 'dsb')
    runtime['ptysById'].get(PTY_ID)!.foregroundAgent = 'dsb'
    const deliver = watchDelivery(runtime)
    runtime.onPtyData(PTY_ID, `${osc('⠋ - DeepSeek Build')}working\n`, Date.now())
    expect(deliver).toHaveBeenCalled()
  })

  it('still delivers for an agent whose name is its only rest signal', async () => {
    const { runtime } = await makeRuntime('grok', 'grok')
    const deliver = watchDelivery(runtime)
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
