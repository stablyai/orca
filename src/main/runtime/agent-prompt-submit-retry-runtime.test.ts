import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../shared/agent-prompt-injection'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import type { OrcaRuntimeService } from './orca-runtime'
import { dispatchPreambleSendOptions } from './orchestration/preamble'
import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-retry',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-retry',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const RETRY_DELAY_MS = TUI_AGENT_CONFIG.codex.submitRetryDelayMs!

// Worker-start's send into a Codex it just launched in a terminal it created.
function launchSendOptions(requestId: string): RuntimeAgentPromptWriteOptions {
  return { ...dispatchPreambleSendOptions(requestId), promptTarget: 'just-launched-agent' }
}

type Enter = { at: number }

async function createRetryRuntime(
  agent: TuiAgent,
  onEnter: (runtime: OrcaRuntimeService, enterIndex: number) => void = () => undefined
): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  writes: string[]
  enters: Enter[]
  pastes: () => number
}> {
  const enters: Enter[] = []
  let pastes = 0
  const fixture = await createAgentPromptSubmissionRuntime((runtime, data) => {
    if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
      pastes += 1
    }
    if (data === '\r') {
      enters.push({ at: Date.now() })
      onEnter(runtime, enters.length)
    }
  }, agent)
  fixture.runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
  return { ...fixture, enters, pastes: () => pastes }
}

function trackSettled<T>(promise: Promise<T>): { settled: () => boolean } {
  let settled = false
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  return { settled: () => settled }
}

describe('host Codex retry Enter for a just-launched agent', () => {
  afterEach(() => vi.useRealTimers())

  it('writes one retry Enter on the dispatch path before the send returns', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes, enters, pastes } = await createRetryRuntime('codex')

    const send = runtime.sendTerminalAgentPrompt(
      handle,
      'dispatch brief',
      launchSendOptions('dispatch-retry')
    )
    const tracked = trackSettled(send)
    await vi.advanceTimersByTimeAsync(0)
    while (enters.length === 0) {
      await vi.advanceTimersByTimeAsync(10)
    }
    await vi.advanceTimersByTimeAsync(enters[0].at + RETRY_DELAY_MS - 1 - Date.now())
    expect(enters).toHaveLength(1)
    expect(tracked.settled()).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(enters).toHaveLength(2)
    expect(enters[1].at - enters[0].at).toBe(RETRY_DELAY_MS)
    await vi.runAllTimersAsync()
    const result = await send
    expect(pastes()).toBe(1)
    const paste = writes.find((data) => data.includes(AGENT_PROMPT_BRACKETED_PASTE_END))!
    expect(result.bytesWritten).toBe(Buffer.byteLength(paste, 'utf8') + 2)
    expect(result.prompt).toMatchObject({ requestId: 'dispatch-retry', stages: ['input_accepted'] })
  })

  it('observes a turn that only the retry Enter started', async () => {
    vi.useFakeTimers()
    const { runtime, handle, enters } = await createRetryRuntime('codex', (runtime, index) => {
      if (index === 2) {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })

    const send = runtime.sendTerminalAgentPrompt(
      handle,
      'dispatch brief',
      launchSendOptions('dispatch-retry-started')
    )
    await vi.runAllTimersAsync()

    await expect(send).resolves.toMatchObject({
      prompt: { requestId: 'dispatch-retry-started', stages: ['input_accepted', 'turn_started'] }
    })
    expect(enters).toHaveLength(2)
  })

  it('sends a non-retry agent exactly one Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, enters } = await createRetryRuntime('claude')

    const send = runtime.sendTerminalAgentPrompt(
      handle,
      'dispatch brief',
      launchSendOptions('dispatch-claude')
    )
    await vi.runAllTimersAsync()
    await send

    expect(enters).toHaveLength(1)
  })

  it('sends a Codex that was not just launched exactly one Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, enters } = await createRetryRuntime('codex')

    // Re-dispatch or coordinator dispatch to a running worker, then `terminal send --enter`.
    const dispatch = runtime.sendTerminalAgentPrompt(
      handle,
      'dispatch brief',
      dispatchPreambleSendOptions('dispatch-running')
    )
    await vi.runAllTimersAsync()
    await dispatch
    expect(enters).toHaveLength(1)

    const send = runtime.sendTerminalAgentPrompt(handle, 'follow-up', {
      acceptQueued: true,
      requestId: 'terminal-send-running'
    })
    await vi.runAllTimersAsync()
    await send
    expect(enters).toHaveLength(2)
  })

  it('skips the retry when the request is aborted and keeps the accepted receipt', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, enters } = await createRetryRuntime('codex', (_runtime, index) => {
      if (index === 1) {
        controller.abort()
      }
    })
    const accepted = vi.fn()

    const send = runtime.sendTerminalAgentPrompt(handle, 'dispatch brief', {
      ...launchSendOptions('dispatch-aborted'),
      signal: controller.signal,
      onInputAccepted: accepted
    })
    const settled = send.catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    await settled

    expect(enters).toHaveLength(1)
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.objectContaining({ stages: ['input_accepted'] }) })
    )
  })

  it('skips the retry after a PTY generation change and still reports input accepted', async () => {
    vi.useFakeTimers()
    const { runtime, handle, enters } = await createRetryRuntime('codex', (runtime, index) => {
      if (index === 1) {
        runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-prompt',
          { value: 0, generation: 'reset' },
          runtime.getPtyOutputSequence('pty-prompt')
        )
      }
    })

    const send = runtime.sendTerminalAgentPrompt(
      handle,
      'dispatch brief',
      launchSendOptions('dispatch-reset')
    )
    await vi.runAllTimersAsync()

    await expect(send).resolves.toMatchObject({
      prompt: { requestId: 'dispatch-reset', stages: ['input_accepted'] }
    })
    expect(enters).toHaveLength(1)
  })

  it('skips the retry when the caller write guard refuses it', async () => {
    vi.useFakeTimers()
    const { runtime, handle, enters } = await createRetryRuntime('codex')
    let guardCalls = 0

    const send = runtime.sendTerminalAgentPrompt(handle, 'dispatch brief', {
      ...launchSendOptions('dispatch-guard'),
      beforeWrite: async () => {
        guardCalls += 1
        if (guardCalls > 2) {
          throw new Error('terminal_guard_not_writable')
        }
      }
    })
    await vi.runAllTimersAsync()

    await expect(send).resolves.toMatchObject({
      prompt: { requestId: 'dispatch-guard', stages: ['input_accepted'] }
    })
    expect(guardCalls).toBe(3)
    expect(enters).toHaveLength(1)
  })

  it('skips the retry when a permission prompt opens after the first Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, enters } = await createRetryRuntime('codex', (runtime, index) => {
      if (index === 1) {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
      }
    })

    const send = runtime.sendTerminalAgentPrompt(
      handle,
      'dispatch brief',
      launchSendOptions('dispatch-permission')
    )
    await vi.runAllTimersAsync()

    await expect(send).resolves.toMatchObject({
      prompt: { requestId: 'dispatch-permission', observation: 'permission' }
    })
    expect(enters).toHaveLength(1)
  })
})
