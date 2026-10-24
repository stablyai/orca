import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import { resolveAgentPromptSubmitDelayForAgent } from '../../../shared/agent-prompt-injection'
import type { TuiAgent } from '../../../shared/tui-agent'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_PROMPT_SUBMISSION_METHODS } from './methods/terminal/terminal-prompt-submission-methods'

vi.mock('../../git/worktree', () => ({
  listWorktrees: async () => [],
  listWorktreesStrict: async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
  ]
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

async function createHarness(agent: TuiAgent = 'claude') {
  const writeTimes: number[] = []
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
    () => writeTimes.push(Date.now()),
    agent
  )
  let permission = false
  vi.spyOn(runtime, 'getTerminalAgentStatus').mockImplementation(async () => ({
    handle,
    isRunningAgent: true,
    status: permission ? 'permission' : 'idle'
  }))
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_PROMPT_SUBMISSION_METHODS })
  const submit = (requestId: string, prompt: string, clientId = 'desktop-1') =>
    dispatcher.dispatch({
      id: requestId,
      authToken: 'token',
      method: 'terminal.submitPrompt',
      params: { terminal: handle, requestId, prompt, client: { id: clientId, type: 'desktop' } }
    })
  const wait = (requestId: string, timeoutMs = 0, signal?: AbortSignal) =>
    dispatcher.dispatch(
      {
        id: `wait-${requestId}`,
        authToken: 'token',
        method: 'terminal.waitPrompt',
        params: { terminal: handle, requestId, timeoutMs }
      },
      { signal }
    )
  return {
    runtime,
    handle,
    writes,
    writeTimes,
    submit,
    wait,
    block: () => {
      permission = true
    }
  }
}

describe('host-owned terminal prompt submissions', () => {
  it('serializes whole submissions from different clients when the second note is shorter', async () => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const { submit, wait, writes } = await createHarness()
    const admission = submit('large', 'x'.repeat(320_000))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(admission).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'pending' } }
    })
    await submit('short', 'follow-up', 'desktop-2')
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('x'.repeat(320_000))
    await vi.runAllTimersAsync()
    expect(writes).toEqual([
      `\x1b[200~${'x'.repeat(320_000)}\x1b[201~`,
      '\r',
      '\x1b[200~follow-up\x1b[201~',
      '\r'
    ])
    for (const requestId of ['large', 'short']) {
      await expect(wait(requestId)).resolves.toMatchObject({
        ok: true,
        result: { submission: { requestId, status: 'submitted', send: { accepted: true } } }
      })
    }
  })

  it.each(['claude', 'codex'] as const)(
    'submits a small %s note without waiting for a render marker',
    async (agent) => {
      vi.useFakeTimers()
      const { submit, wait, writes } = await createHarness(agent)
      const prompt = 'browser feedback'
      const delay = resolveAgentPromptSubmitDelayForAgent(process.platform, prompt, agent)

      await submit('small', prompt)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(writes).toEqual([`\x1b[200~${prompt}\x1b[201~`])
      await vi.advanceTimersByTimeAsync(1)
      expect(writes.at(-1)).toBe('\r')
      await expect(wait('small')).resolves.toMatchObject({
        ok: true,
        result: { submission: { status: 'submitted' } }
      })
      await vi.runAllTimersAsync()
      expect(writes.filter((text) => text === '\r')).toHaveLength(1)
    }
  )

  it('keeps the ConPTY ingest floor when submitting notes without a render marker', async () => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const { submit, wait, writes, writeTimes } = await createHarness('codex')
    const prompt = 'x'.repeat(320_000)
    const delay = resolveAgentPromptSubmitDelayForAgent('win32', prompt, 'codex')

    const admission = submit('ingest', prompt)
    await vi.advanceTimersByTimeAsync(3_342)
    await admission
    expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(delay - (Date.now() - writeTimes[0]) - 1)
    expect(writes).not.toContain('\r')
    await vi.advanceTimersByTimeAsync(1)
    expect(writes.filter((text) => text === '\r')).toHaveLength(1)
    await expect(wait('ingest')).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'submitted' } }
    })
  })

  it('acknowledges admission immediately and long-polls a paste exceeding the RPC budget', async () => {
    vi.useFakeTimers()
    const { submit, wait, writes } = await createHarness('aider')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const admission = submit('large', 'x'.repeat(1024 * 1024))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(admission).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'pending' } }
    })
    const observation = wait('large', 10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(observation).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'pending' } }
    })
    expect(writes).toHaveLength(1)
    const completion = wait('large', 10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(completion).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'submitted' } }
    })
    expect(writes.at(-1)).toBe('\r')
  })

  it('uses the foreground Antigravity policy for a restored folder leaf without a tracked PTY', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const writes: string[] = []
    runtime.setPtyController({
      write: (_id, text) => {
        writes.push(text)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'agy'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab',
          worktreeId: 'folder',
          title: 'Antigravity',
          activeLeafId: 'pane',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab',
          worktreeId: 'folder',
          leafId: 'pane',
          paneRuntimeId: 1,
          ptyId: 'restored',
          paneTitle: 'Antigravity'
        }
      ]
    })
    const [terminal] = (await runtime.listTerminals()).terminals
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_PROMPT_SUBMISSION_METHODS })
    const prompt = 'feedback line\n'.repeat(400)
    const delay = resolveAgentPromptSubmitDelayForAgent(process.platform, prompt, 'antigravity')
    await dispatcher.dispatch({
      id: 'submit',
      authToken: 'token',
      method: 'terminal.submitPrompt',
      params: {
        terminal: terminal.handle,
        requestId: 'restored',
        prompt,
        client: { id: 'desktop', type: 'desktop' }
      }
    })
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(writes.at(-1)).toBe('\r')
    await expect(
      runtime.waitForTerminalAgentPrompt(terminal.handle, 'restored', 0)
    ).resolves.toMatchObject({ status: 'submitted', send: { prompt: { provider: 'antigravity' } } })
  })

  it('keeps OMP paste and Enter in the same write', async () => {
    vi.useFakeTimers()
    const { submit, wait, writes } = await createHarness('omp')
    await submit('omp', 'feedback\n'.repeat(400))
    await vi.runAllTimersAsync()
    expect(writes).toEqual([`\x1b[200~${'feedback\n'.repeat(400)}\x1b[201~\r`])
    await expect(wait('omp')).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'submitted' } }
    })
  })

  it('shares serialization with the existing host prompt sender', async () => {
    vi.useFakeTimers()
    const { runtime, handle, submit, writes } = await createHarness('aider')
    await submit('notes', 'browser feedback')
    await vi.advanceTimersByTimeAsync(100)
    const existingSend = runtime.sendTerminalAgentPrompt(handle, 'another prompt', {
      inputKind: 'driving',
      acceptQueued: true,
      observationTimeoutMs: 0,
      requestId: 'existing'
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toEqual(['\x1b[200~browser feedback\x1b[201~'])
    await vi.runAllTimersAsync()
    await existingSend
    expect(writes).toEqual([
      '\x1b[200~browser feedback\x1b[201~',
      '\r',
      '\x1b[200~another prompt\x1b[201~',
      '\r'
    ])
  })

  it('withholds Enter and reports partial delivery when permission appears during the wait', async () => {
    vi.useFakeTimers()
    const { submit, wait, writes, block } = await createHarness('aider')
    await submit('permission', 'feedback')
    await vi.advanceTimersByTimeAsync(100)
    block()
    await vi.runAllTimersAsync()
    expect(writes).toEqual(['\x1b[200~feedback\x1b[201~'])
    await expect(wait('permission')).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'failed', reason: 'permission', inputWritten: true } }
    })
  })

  it('fences queued and pasted prompts when the terminal incarnation is replaced', async () => {
    vi.useFakeTimers()
    const { runtime, submit, wait, writes } = await createHarness('aider')
    runtime.onPtySpawned('pty-prompt', 'original', { awaitsRegistration: false })
    await submit('first', 'feedback')
    await vi.advanceTimersByTimeAsync(100)
    await submit('second', 'follow-up')
    runtime.onPtySpawned('pty-prompt', 'replacement', { awaitsRegistration: false })
    await vi.runAllTimersAsync()
    expect(writes).toEqual(['\x1b[200~feedback\x1b[201~'])
    await expect(wait('first')).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'failed', inputWritten: true } }
    })
    await expect(wait('second')).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'failed', inputWritten: false } }
    })
  })

  it('replays one receipt without re-pasting and refuses changed text under the same request ID', async () => {
    vi.useFakeTimers()
    const { submit, wait, writes } = await createHarness('aider')
    await submit('retry', 'feedback')
    await submit('retry', 'feedback')
    await expect(submit('retry', 'different')).resolves.toMatchObject({ ok: false })
    await vi.runAllTimersAsync()
    await expect(submit('retry', 'feedback')).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'submitted' } }
    })
    expect(writes).toEqual(['\x1b[200~feedback\x1b[201~', '\r'])
    await expect(wait('retry')).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'submitted' } }
    })
  })

  it('keeps the host submission alive when an observation request disconnects', async () => {
    vi.useFakeTimers()
    const { submit, wait, writes } = await createHarness('aider')
    await submit('disconnect', 'feedback')
    const controller = new AbortController()
    const observation = wait('disconnect', 10_000, controller.signal)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await expect(observation).resolves.toMatchObject({ ok: false })
    await vi.runAllTimersAsync()
    await expect(wait('disconnect')).resolves.toMatchObject({
      ok: true,
      result: { submission: { status: 'submitted' } }
    })
    expect(writes).toEqual(['\x1b[200~feedback\x1b[201~', '\r'])
  })
})
