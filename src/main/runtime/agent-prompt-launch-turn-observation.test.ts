import { afterEach, describe, expect, it, vi } from 'vitest'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { dispatchPreambleSendOptions } from './orchestration/preamble'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-turn-observation',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-turn-observation',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const RETRY_DELAY_MS = TUI_AGENT_CONFIG.opencode.submitRetryDelayMs ?? 0

type HookRow = { state: 'done' | 'working' | 'waiting'; stateStartedAt: number; prompt: string }

/**
 * An OpenCode pane whose status plugin reports through the hook store. It has posted nothing
 * before the first submit; `onEnter` runs on each Enter so a test can post what OpenCode would.
 */
async function createOpenCodePane(onEnter: (enter: number, post: (row: HookRow) => void) => void) {
  let handle = ''
  let hook: HookRow | null = null
  const writes: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only repos, worktree meta and settings from this store fixture.
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    getAgentStatusSnapshot: () =>
      hook
        ? [
            {
              paneKey: 'prompt-pane',
              terminalHandle: handle,
              state: hook.state,
              prompt: hook.prompt,
              agentType: 'opencode',
              connectionId: null,
              receivedAt: Date.now(),
              stateStartedAt: hook.stateStartedAt
            }
          ]
        : []
  })
  const post = (row: HookRow): void => {
    hook = row
  }
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
    write: (_ptyId, data) => {
      writes.push(data)
      if (data === '\r') {
        onEnter(
          writes.filter((write) => write === '\r').length,
          (row) => void setTimeout(() => post(row), 50)
        )
      }
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  handle = (
    await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
      launchAgent: 'opencode'
    })
  ).handle
  const sent = runtime.sendTerminalAgentPrompt(handle, 'Task: reply with OK', {
    ...dispatchPreambleSendOptions('request-1'),
    retrySubmitAfterLaunch: true
  })
  return { runtime, sent, enters: () => writes.filter((data) => data === '\r').length }
}

const WORKING = (): HookRow => ({
  state: 'working',
  stateStartedAt: Date.now(),
  prompt: 'Task: reply with OK'
})
const UNSUPPORTED_RECEIPT = { prompt: { provider: 'unsupported', observation: 'unsupported' } }

// Why: OpenCode's plugin posts `working` right after every real submit and nothing for a brief
// stuck in its box, so a turn this request started makes the retry Enter unnecessary. The receipt
// stays unsupported: with no post before the first submit, a plugin that never loaded looks the
// same as a stuck brief.
describe('retry Enter skip on a launched OpenCode worker first dispatch', () => {
  afterEach(() => vi.useRealTimers())

  it('skips the retry Enter when the first Enter started a turn', async () => {
    vi.useFakeTimers()
    const { sent, enters } = await createOpenCodePane((enter, post) => {
      if (enter === 1) {
        post(WORKING())
      }
    })

    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject(UNSUPPORTED_RECEIPT)
    expect(enters()).toBe(1)
  })

  it('retries once when no turn starts, with the same receipt', async () => {
    vi.useFakeTimers()
    const { sent, enters } = await createOpenCodePane(() => {})

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 1_000)
    await expect(sent).resolves.toMatchObject(UNSUPPORTED_RECEIPT)
    expect(enters()).toBe(2)
  })

  it("does not count the plugin's first `done` post as a turn start", async () => {
    vi.useFakeTimers()
    // The plugin's first post, `done` with an empty prompt, arrives just after the submit.
    const { sent, enters } = await createOpenCodePane((enter, post) => {
      if (enter === 1) {
        post({ state: 'done', stateStartedAt: Date.now(), prompt: '' })
      }
    })

    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject(UNSUPPORTED_RECEIPT)
    expect(enters()).toBe(2)
  })

  it('skips the retry Enter when OpenCode asks for permission after the first Enter', async () => {
    vi.useFakeTimers()
    const { sent, enters } = await createOpenCodePane((enter, post) => {
      if (enter === 1) {
        post({ state: 'waiting', stateStartedAt: Date.now(), prompt: '' })
      }
    })

    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject(UNSUPPORTED_RECEIPT)
    expect(enters()).toBe(1)
  })

  it('leaves the first Enter standing when the pane exits during the wait', async () => {
    vi.useFakeTimers()
    const { runtime, sent, enters } = await createOpenCodePane((enter) => {
      if (enter === 1) {
        setTimeout(() => void runtime.onPtyExit('pty-prompt', 0), 500)
      }
    })

    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject({ accepted: true, ...UNSUPPORTED_RECEIPT })
    expect(enters()).toBe(1)
  })
})
