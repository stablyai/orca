import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeTuiIdleRuntime } from './tui-idle-wait-test-harness'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-session-contracts'

import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

import { registerBoundPty } from '../../bind-first-pane.test-fixture'

// #6011: name-only Codex/Devin titles were stored as idle and prematurely satisfied tui-idle; distinguish settling, corroborating and veto evidence.

const POLL_INTERVAL_MS = 2000

const NAME_ONLY_TITLE = 'Codex'
const EXPLICIT_IDLE_TITLE = 'Codex ready'

// Muse 1.3.0 node-pty capture with echo provider and --trust-workspace; its OSC title stays the bare cwd.
const MUSE_READY_TAIL = [
  '  Muse Code 1.3.0',
  '  Skills: 77 loaded · 1 warning · 28 details hidden (ctrl+o to expand)',
  '── Voice input (⌥ + v to start) ──────────────────────────────────────────',
  '❯ ────────────────────────────────────────────────────────────────────',
  '  muse-spark-1.3 · max · ~/Downloads/interview-coach · YOLO'
]

/** Keep output younger than the quiescence window. */

const E2E_WORKTREE_ID = 'repo-1::/tmp/name-only-idle'
const E2E_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const E2E_PTY_ID = 'pty-name-only-idle'
const WORKING_TITLE = '⠋ Codex'
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

const E2E_GRAPH = {
  tabs: [
    {
      tabId: 'tab-1',
      worktreeId: E2E_WORKTREE_ID,
      title: 'Agent',
      activeLeafId: E2E_LEAF_ID,
      layout: null
    }
  ],
  leaves: [
    {
      tabId: 'tab-1',
      worktreeId: E2E_WORKTREE_ID,
      leafId: E2E_LEAF_ID,
      paneRuntimeId: 1,
      ptyId: E2E_PTY_ID,
      paneTitle: null,
      title: ''
    }
  ]
} satisfies RuntimeSyncWindowGraph

async function makeRuntime(launchAgent?: TuiAgent) {
  const runtime = makeTuiIdleRuntime({
    repoPath: '/tmp/name-only-idle',
    getForegroundProcess: async () => 'codex'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, E2E_GRAPH)
  if (launchAgent) {
    registerBoundPty(runtime, E2E_PTY_ID, E2E_WORKTREE_ID, null, {
      tabId: 'tab-1',
      leafId: E2E_LEAF_ID,
      incarnationId: 'name-only-incarnation',
      agentLaunchAuthority: { launchToken: 'name-only-launch', launchAgent }
    })
  }
  const { terminals } = await runtime.listTerminals(`id:${E2E_WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle }
}

function oscTitle(title: string): string {
  return `${ESC}]0;${title}${BEL}`
}

describe('tui-idle over the live OSC title pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not settle on a name-only title arriving mid-stream', async () => {
    const { runtime, handle } = await makeRuntime('codex')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(WORKING_TITLE)}building\n`, Date.now())

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    // The agent is mid-turn and repaints its title to the bare product name.
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}more output\n`, Date.now())

    const assertion = expect(waiting).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(250)
    await assertion
  })

  it('settles when the agent reports idle explicitly', async () => {
    const { runtime, handle } = await makeRuntime('codex')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(WORKING_TITLE)}building\n`, Date.now())

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}more output\n`, Date.now())
    runtime.onPtyData(E2E_PTY_ID, oscTitle(EXPLICIT_IDLE_TITLE), Date.now())

    await expect(waiting).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
  })

  it('settles a quiet Muse ready screen over the live PTY pipeline', async () => {
    const { runtime, handle } = await makeRuntime('muse')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle('tmp')}${MUSE_READY_TAIL.join('\n')}\n`, Date.now())

    const assertion = expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 15_000 })
    ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await assertion
  }, 20_000)
})
