import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_SUBMIT_DELAY_MS
} from '../../shared/agent-prompt-injection'
import type { TuiAgent } from '../../shared/tui-agent'
import { PtyInputTransactionOwner } from '../pty-input-transaction'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

const WORKTREE_PATH = '/tmp/worktree-a'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-delivery-state-machine',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-delivery-state-machine',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

async function createPromptRuntime(options: {
  launchAgent: TuiAgent
  foregroundAgent?: TuiAgent
  foregroundProcess?: string | (() => string | null | Promise<string | null>)
  inspectProcess?: () => {
    foregroundProcess: string | null
    hasChildProcesses: boolean
    unavailable?: true
  }
  onWrite?: (runtime: OrcaRuntimeService, data: string) => void
}): Promise<{ runtime: OrcaRuntimeService; handle: string; writes: string[] }> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const writes: string[] = []
  const inputOwner = new PtyInputTransactionOwner((_ptyId, data) => {
    writes.push(data)
    options.onWrite?.(runtime, data)
    return true
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
    write: (ptyId, data) => inputOwner.write(ptyId, data),
    beginInputTransaction: (ptyId, generation, kind) => inputOwner.begin(ptyId, generation, kind),
    kill: () => true,
    inspectProcess: options.inspectProcess ? async () => options.inspectProcess!() : undefined,
    getForegroundProcess: async () =>
      typeof options.foregroundProcess === 'function'
        ? options.foregroundProcess()
        : (options.foregroundProcess ?? options.foregroundAgent ?? options.launchAgent)
  })
  const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
    launchAgent: options.launchAgent
  })
  return { runtime, handle: terminal.handle, writes }
}

describe('agent prompt delivery state machine', () => {
  afterEach(() => vi.useRealTimers())

  it('submits OpenCode only after fresh post-paste readiness', async () => {
    vi.useFakeTimers()
    let composerReady = false
    let acceptedEnters = 0
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      onWrite: (runtime, data) => {
        if (data !== '\r' || !composerReady) {
          return
        }
        acceptedEnters += 1
        runtime.onPtyData('pty-prompt', '\x1b]0;OpenCode working\x07', Date.now())
      }
    })
    runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(writes).not.toContain('\r')
    composerReady = true
    runtime.onPtyData('pty-prompt', '\x1b[?2', Date.now())
    runtime.onPtyData('pty-prompt', '5h', Date.now())
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(acceptedEnters).toBe(1)
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it.each(['claude', 'codex'] as const)(
    'reports %s local-command output as unknown without lifecycle evidence',
    async (agent) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createPromptRuntime({
        launchAgent: agent,
        onWrite: (runtime, data) => {
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
          }
          if (data === '\r') {
            runtime.onPtyData('pty-prompt', 'Unknown command\r\n', Date.now())
          }
        }
      })
      const outcome = runtime
        .sendTerminalAgentPrompt(handle, '/not-a-command')
        .catch((error: unknown) => error)

      await vi.runAllTimersAsync()

      await expect(outcome).resolves.toMatchObject({
        code: 'operation_unknown',
        data: { operation: 'agent_prompt_delivery', reason: 'agent_prompt_stalled' }
      })
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    }
  )

  it('does not accept an OpenCode redraw after a swallowed Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      onWrite: (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
        }
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b[2J\x1b[H› review this', Date.now())
        }
      }
    })
    const outcome = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { operation: 'agent_prompt_delivery', reason: 'agent_prompt_stalled' }
    })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('retains uncertainty without Enter when OpenCode never becomes ready', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({ launchAgent: 'opencode' })
    const outcome = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { operation: 'agent_prompt_delivery', reason: 'agent_prompt_not_ready' }
    })
    expect(writes).not.toContain('\r')
  })

  it('uses current OpenCode policy instead of stale Codex launch metadata', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'codex',
      foregroundAgent: 'opencode'
    })
    const outcome = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      data: { reason: 'agent_prompt_not_ready' }
    })
    expect(writes).not.toContain('\r')
  })

  it('uses current Codex policy instead of stale OpenCode launch metadata', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      foregroundAgent: 'codex',
      onWrite: (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')

    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('rejects a current shell instead of using stale OpenCode metadata', async () => {
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      foregroundProcess: 'zsh'
    })

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'agent_prompt_target_changed'
    )
    expect(writes).toEqual([])
  })

  it('rejects a null foreground observation instead of trusting launch metadata', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      inspectProcess: () => ({ foregroundProcess: null, hasChildProcesses: false }),
      onWrite: (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
        }
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;OpenCode working\x07', Date.now())
        }
      }
    })

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'agent_prompt_target_changed'
    )
    expect(writes).toEqual([])
  })

  it('uses launch metadata only when inspection is explicitly unavailable', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      inspectProcess: () => ({
        foregroundProcess: null,
        hasChildProcesses: true,
        unavailable: true
      }),
      onWrite: (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
        }
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;OpenCode working\x07', Date.now())
        }
      }
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    await vi.runAllTimersAsync()
    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes).toContain('\r')
  })

  it('does not submit after the agent returns to a shell', async () => {
    vi.useFakeTimers()
    let foregroundProcess = 'opencode'
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      foregroundProcess: () => foregroundProcess,
      onWrite: (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          foregroundProcess = 'zsh'
          runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
        }
      }
    })
    const outcome = runtime.sendTerminalAgentPrompt(handle, 'review this').catch((error) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { reason: 'agent_prompt_target_changed' }
    })
    expect(writes).not.toContain('\r')
  })

  it('rechecks permission after the final foreground inspection', async () => {
    let finishInspection!: (process: string | null) => void
    let enterInspection!: () => void
    const inspectionEntered = new Promise<void>((resolve) => {
      enterInspection = resolve
    })
    const finalInspection = new Promise<string | null>((resolve) => {
      finishInspection = resolve
    })
    let blockInspection = false
    let reportedInspection = false
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'codex',
      foregroundProcess: () => {
        if (blockInspection) {
          if (!reportedInspection) {
            reportedInspection = true
            enterInspection()
          }
          return finalInspection
        }
        return 'codex'
      },
      onWrite: (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          blockInspection = true
          runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
        }
      }
    })
    const outcome = runtime.sendTerminalAgentPrompt(handle, 'review this').catch((error) => error)

    await inspectionEntered
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
    finishInspection('codex')

    await expect(outcome).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { reason: 'agent_prompt_blocked' }
    })
    expect(writes).not.toContain('\r')
  })

  it.each([
    { nextProcess: 'zsh', label: 'a shell' },
    { nextProcess: 'gemini', label: 'another agent' }
  ])('does not submit after Aider changes to $label', async ({ nextProcess }) => {
    vi.useFakeTimers()
    let foregroundProcess = 'aider'
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'aider',
      foregroundProcess: () => foregroundProcess,
      onWrite: (_runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          foregroundProcess = nextProcess
        }
      }
    })
    const outcome = runtime.sendTerminalAgentPrompt(handle, 'review this').catch((error) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { reason: 'agent_prompt_target_changed' }
    })
    expect(writes).not.toContain('\r')
  })

  it('retains metadata fallback when foreground inspection is unavailable throughout', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      inspectProcess: () => ({
        foregroundProcess: null,
        hasChildProcesses: true,
        unavailable: true
      }),
      onWrite: (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
        }
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;OpenCode working\x07', Date.now())
        }
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')

    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('routes a query reply after the prompt paste frame closes', async () => {
    vi.useFakeTimers()
    let queryReply: Promise<unknown> | undefined
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      onWrite: (runtime, data) => {
        if (data.includes('\x1b[200~') && !data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          queueMicrotask(() => {
            queryReply = runtime.sendTerminal(handle, { text: '\x1b[?0u' })
          })
        }
      }
    })
    const outcome = runtime
      .sendTerminalAgentPrompt(handle, 'x'.repeat(20_000))
      .catch((error) => error)

    await vi.runAllTimersAsync()

    await expect(queryReply).resolves.toMatchObject({ accepted: true })
    await expect(outcome).resolves.toMatchObject({ code: 'operation_unknown' })
    const pasteEnd = writes.findIndex((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))
    expect(writes.indexOf('\x1b[?0u')).toBeGreaterThan(pasteEnd)
    expect(writes).not.toContain('\r')
  })

  it('does not run a queued prompt after an unknown delivery outcome', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({ launchAgent: 'opencode' })
    const first = runtime.sendTerminalAgentPrompt(handle, 'first prompt').catch((error) => error)
    const second = runtime.sendTerminalAgentPrompt(handle, 'second prompt').catch((error) => error)

    await vi.runAllTimersAsync()

    await expect(first).resolves.toMatchObject({ code: 'operation_unknown' })
    await expect(second).resolves.toMatchObject({ code: 'operation_unknown' })
    expect(writes.join('')).toContain('first prompt')
    expect(writes.join('')).not.toContain('second prompt')
  })

  it('reports a generation reset after paste as unknown', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      onWrite: (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
          runtime.synchronizePtyOutputSequenceFromProvider(
            'pty-prompt',
            { value: 0, generation: 'reset' },
            runtime.getPtyOutputSequence('pty-prompt')
          )
        }
      }
    })
    const outcome = runtime.sendTerminalAgentPrompt(handle, 'review this').catch((error) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { reason: 'terminal_handle_stale' }
    })
    expect(writes).not.toContain('\r')
  })

  it('reports a generation reset after a partial paste as unknown', async () => {
    let reset = false
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      onWrite: (runtime) => {
        if (reset) {
          return
        }
        reset = true
        runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-prompt',
          { value: 0, generation: 'reset' },
          runtime.getPtyOutputSequence('pty-prompt')
        )
      }
    })

    await expect(runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000))).rejects.toMatchObject(
      {
        code: 'operation_unknown',
        data: { reason: 'terminal_handle_stale' }
      }
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
  })

  it('reports a generation reset immediately after Enter as unknown', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      onWrite: (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
        }
        if (data === '\r') {
          runtime.synchronizePtyOutputSequenceFromProvider(
            'pty-prompt',
            { value: 0, generation: 'reset' },
            runtime.getPtyOutputSequence('pty-prompt')
          )
        }
      }
    })
    const outcome = runtime.sendTerminalAgentPrompt(handle, 'review this').catch((error) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { reason: 'terminal_handle_stale' }
    })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('lets direct input cancel an unacknowledged agent prompt', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({ launchAgent: 'opencode' })
    const promptOutcome = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)

    await expect(runtime.sendTerminal(handle, { text: 'manual input' })).resolves.toMatchObject({
      accepted: true
    })
    await vi.runAllTimersAsync()

    await expect(promptOutcome).resolves.toMatchObject({ code: 'operation_unknown' })
    expect(writes.join('')).toContain('manual input')
    expect(writes.filter((data) => data === '\r')).toHaveLength(0)
  })

  it('does not attribute post-Enter user activity to the prompt', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'aider',
      onWrite: (runtime, data) => {
        if (data === 'manual input') {
          runtime.onPtyData('pty-prompt', '\x1b]0;Aider working\x07', Date.now())
        }
      }
    })
    const prompt = runtime.sendTerminalAgentPrompt(handle, 'review this').catch((error) => error)

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    await runtime.sendTerminal(handle, { text: 'manual input' })
    await vi.runAllTimersAsync()

    await expect(prompt).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { reason: 'terminal_input_superseded' }
    })
  })

  it('keeps a prompt authoritative until guarded direct input is admitted', async () => {
    let releaseWrite!: () => void
    let enteredWrite!: () => void
    const entered = new Promise<void>((resolve) => {
      enteredWrite = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const { runtime, handle, writes } = await createPromptRuntime({ launchAgent: 'aider' })
    const direct = runtime.sendTerminal(
      handle,
      { text: 'manual input' },
      {
        beforeWrite: async () => {
          enteredWrite()
          await blocked
        }
      }
    )
    await entered

    const prompt = runtime.sendTerminalAgentPrompt(handle, 'review this').catch((error) => error)
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve()
    }
    expect(writes.join('')).toContain('review this')

    releaseWrite()
    await direct
    await expect(prompt).resolves.toMatchObject({ code: 'operation_unknown' })

    expect(writes.join('')).toContain('manual input')
  })
})
