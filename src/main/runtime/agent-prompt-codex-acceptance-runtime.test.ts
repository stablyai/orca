import { afterEach, describe, expect, it, vi } from 'vitest'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { AgentPromptAcceptance } from '../../shared/agent-status-ipc-payload'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const PTY_ID = 'pty-codex'
const RETRY_DELAY_MS = TUI_AGENT_CONFIG.codex.submitRetryDelayMs!
// Codex's startup spinner: it animates while MCP servers boot, before any prompt.
const STARTUP_SPINNER_TITLE = '\x1b]0;⠋ worktree-a\x07'

type HookRow = {
  state: 'done' | 'working'
  stateStartedAt: number
  promptAcceptance?: AgentPromptAcceptance
}

async function createCodexRuntime(
  options: { launchedWithHooks: boolean },
  onEnter: (enterIndex: number, hook: HookRow, runtime: OrcaRuntimeService) => void
): Promise<{ runtime: OrcaRuntimeService; handle: string; enterTimes: number[] }> {
  let handle = ''
  const hook: HookRow = { state: 'done', stateStartedAt: Date.now() }
  const enterTimes: number[] = []
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    getAgentStatusSnapshot: () => [
      {
        paneKey: 'codex-pane',
        terminalHandle: handle,
        state: hook.state,
        prompt: '',
        agentType: 'codex',
        connectionId: null,
        receivedAt: Date.now(),
        stateStartedAt: hook.stateStartedAt,
        ...(hook.promptAcceptance ? { promptAcceptance: hook.promptAcceptance } : {})
      }
    ]
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: (_ptyId, data) => {
      if (data === '\r') {
        enterTimes.push(Date.now())
        onEnter(enterTimes.length, hook, runtime)
      }
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  handle = (
    await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
      launchAgent: 'codex',
      // A launch config is what mints the launch token Orca's hooks report with.
      ...(options.launchedWithHooks
        ? { launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} } }
        : {})
    })
  ).handle
  return { runtime, handle, enterTimes }
}

function acceptPrompt(hook: HookRow): void {
  hook.state = 'working'
  hook.stateStartedAt = Date.now()
  hook.promptAcceptance = { acceptedAt: Date.now(), providerTurnId: 'turn-1' }
}

function sendBrief(runtime: OrcaRuntimeService, handle: string) {
  return runtime.sendTerminalAgentPrompt(handle, 'worker brief', {
    acceptQueued: true,
    requestId: 'dispatch-1',
    observationTimeoutMs: 20_000
  })
}

describe('Codex prompt delivery', () => {
  afterEach(() => vi.useRealTimers())

  it('retries Enter exactly once when the first Enter starts no turn', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const { runtime, handle, enterTimes } = await createCodexRuntime(
      { launchedWithHooks: true },
      (enterIndex, hook) => {
        if (enterIndex === 2) {
          acceptPrompt(hook)
        }
      }
    )

    const submission = sendBrief(runtime, handle)
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({
      prompt: { stages: ['input_accepted', 'turn_started'] }
    })
    expect(enterTimes).toHaveLength(2)
    expect(enterTimes[1]! - enterTimes[0]!).toBeGreaterThanOrEqual(RETRY_DELAY_MS)
    expect(enterTimes[1]! - enterTimes[0]!).toBeLessThan(RETRY_DELAY_MS + 200)
  })

  it('sends no retry Enter when the first Enter was accepted', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const { runtime, handle, enterTimes } = await createCodexRuntime(
      { launchedWithHooks: true },
      (_enterIndex, hook) => acceptPrompt(hook)
    )

    const submission = sendBrief(runtime, handle)
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({
      prompt: { stages: ['input_accepted', 'turn_started'] }
    })
    expect(enterTimes).toHaveLength(1)
  })

  it('reports a first-launch startup spinner as unobserved, not as a started turn', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const { runtime, handle, enterTimes } = await createCodexRuntime(
      { launchedWithHooks: true },
      (enterIndex, hook, runtime) => {
        if (enterIndex === 1) {
          // No hook fires: Codex runs SessionStart inside the first turn, which never began.
          runtime.onPtyData(PTY_ID, STARTUP_SPINNER_TITLE, Date.now())
          hook.state = 'working'
        }
      }
    )

    const submission = sendBrief(runtime, handle)
    await vi.runAllTimersAsync()

    const send = await submission
    expect(send.prompt).toMatchObject({ stages: ['input_accepted'], observation: 'supported' })
    expect(enterTimes).toHaveLength(2)
  })

  it('keeps the working-edge rules for a Codex pane launched without Orca hooks', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const { runtime, handle, enterTimes } = await createCodexRuntime(
      { launchedWithHooks: false },
      (enterIndex, _hook, runtime) => {
        if (enterIndex === 1) {
          runtime.onPtyData(PTY_ID, STARTUP_SPINNER_TITLE, Date.now())
        }
      }
    )

    const submission = sendBrief(runtime, handle)
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({
      prompt: { stages: ['input_accepted', 'turn_started'] }
    })
    expect(enterTimes).toHaveLength(1)
  })
})
