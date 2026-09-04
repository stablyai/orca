import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/codex-ready-header',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/codex-ready-header',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const PTY = 'pty-codex'
const BOOT_HEADER = ' >_ OpenAI Codex (v0.152.0)\n model:       loading\n directory:   loading\n'
const READY_HEADER =
  ' >_ OpenAI Codex (v0.152.0)\n model:       gpt-5.6-sol medium\n directory:   /tmp/worktree-a\n'

async function createCodexTerminal(): Promise<{ runtime: OrcaRuntimeService; handle: string }> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: async () => ({ id: PTY }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const terminal = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    launchAgent: 'codex'
  })
  return { runtime, handle: terminal.handle }
}

describe('tui-idle and the Codex boot header', () => {
  afterEach(() => vi.useRealTimers())

  // Why: worker-start pastes as soon as tui-idle resolves; on this header Codex is still booting
  // and the paste lands scrambled on the splash screen or parks unsubmitted.
  it('does not treat a header still loading its model and directory as ready', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createCodexTerminal()
    runtime.onPtyData(PTY, BOOT_HEADER, Date.now())

    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    const rejected = expect(wait).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(3_000)

    await rejected
  })

  it('treats the header as ready once the model and directory are settled', async () => {
    const { runtime, handle } = await createCodexTerminal()
    runtime.onPtyData(PTY, BOOT_HEADER, Date.now())
    runtime.onPtyData(PTY, READY_HEADER, Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({ condition: 'tui-idle', status: 'running' })
  })

  // Why: Codex repaints the rows in place, so a stacked tail holds the loading rows and the settled
  // rows under one banner; the last painted row is the one that counts.
  it('treats settled rows repainted under a single banner as ready', async () => {
    const { runtime, handle } = await createCodexTerminal()
    runtime.onPtyData(
      PTY,
      `${BOOT_HEADER} model:       gpt-5.6-sol medium\n directory:   /tmp/worktree-a\n`,
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({ condition: 'tui-idle', status: 'running' })
  })

  it('does not read a model: label inside the directory value as the model row', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createCodexTerminal()
    runtime.onPtyData(
      PTY,
      ' >_ OpenAI Codex (v0.152.0)\n model:       loading\n directory:   /tmp/model:settled\n',
      Date.now()
    )

    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    const rejected = expect(wait).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(3_000)

    await rejected
  })

  it('does not treat a header whose values have not arrived yet as ready', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createCodexTerminal()
    runtime.onPtyData(PTY, ' >_ OpenAI Codex (v0.152.0)\n model:\n directory:\n', Date.now())

    const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    const rejected = expect(wait).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(3_000)

    await rejected
  })
})
