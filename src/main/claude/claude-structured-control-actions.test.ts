import { describe, expect, it, vi } from 'vitest'
import {
  cancelClaudeTurn,
  answerClaudePrompt,
  stopClaudeBackgroundTasks
} from './claude-structured-control-actions'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeDispatchWaiter, ClaudeSession } from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { sessionFor, userMessage } from './claude-structured-dispatch-test-support'

type InterruptResult = Awaited<ReturnType<ClaudeSession['connection']['interrupt']>>

function sessionWith(input: {
  capabilities?: string[]
  interrupt: (options?: { cancelQueued?: boolean; timeoutMs?: number }) => Promise<InterruptResult>
  cancelAsyncMessage?: (uuid: string) => Promise<void>
  prompts?: ClaudePromptRegistry
}): {
  session: ClaudeSession
  interrupt: ReturnType<typeof vi.fn>
  cancelAsyncMessage: ReturnType<typeof vi.fn>
} {
  const interrupt = vi.fn(input.interrupt)
  const cancelAsyncMessage = vi.fn(input.cancelAsyncMessage ?? (async () => {}))
  const session = sessionFor()
  session.capabilities = input.capabilities ?? []
  session.prompts = input.prompts ?? new ClaudePromptRegistry()
  session.connection.interrupt = interrupt
  session.connection.cancelAsyncMessage = cancelAsyncMessage
  return { session, interrupt, cancelAsyncMessage }
}

describe('cancelClaudeTurn', () => {
  it('interrupts without a receipt on an older CLI and reports the turn cancelled', async () => {
    const { session, interrupt, cancelAsyncMessage } = sessionWith({
      interrupt: async () => undefined
    })

    await expect(cancelClaudeTurn(session, 5_000)).resolves.toEqual({ cancelled: true })
    expect(interrupt).toHaveBeenCalledWith({ timeoutMs: 5_000 })
    expect(cancelAsyncMessage).not.toHaveBeenCalled()
  })

  it('withdraws every still-queued message a plain interrupt receipt reports', async () => {
    const { session, interrupt, cancelAsyncMessage } = sessionWith({
      capabilities: ['interrupt_receipt_v1'],
      interrupt: async () => ({ still_queued: ['queued-1', 'queued-2'] })
    })

    await expect(cancelClaudeTurn(session, 5_000)).resolves.toEqual({ cancelled: true })
    // No cancel_queued capability, so the queue is swept one uuid at a time.
    expect(interrupt).toHaveBeenCalledWith({ timeoutMs: 5_000 })
    expect(cancelAsyncMessage.mock.calls.map((call) => call[0])).toEqual(['queued-1', 'queued-2'])
  })

  it('settles every cancelled queued waiter when the CLI advertises the capability', async () => {
    const cancelled = Array.from({ length: 64 }, (_, index) => `queued-${index}`)
    const { session, interrupt, cancelAsyncMessage } = sessionWith({
      capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
      interrupt: async () => ({ still_queued: [], cancelled })
    })
    const resolutions = cancelled.map(() => vi.fn())
    session.dispatchWaiters = cancelled.map((sentUuid, index): ClaudeDispatchWaiter => ({
      acceptsResult: false,
      clientMessageId: `client-${index}`,
      sentUuid,
      dispatchSequence: index + 1,
      requestedAt: null,
      replayContentKey: `content-${index}`,
      resolve: resolutions[index]!
    }))
    const settled = vi.fn()

    await expect(cancelClaudeTurn(session, 5_000, () => true, settled)).resolves.toEqual({
      cancelled: true
    })
    expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true, timeoutMs: 5_000 })
    expect(cancelAsyncMessage).not.toHaveBeenCalled()
    expect(session.dispatchWaiters).toEqual([])
    expect(resolutions.every((resolve) => resolve.mock.calls[0]?.[0] === null)).toBe(true)
    expect(settled).toHaveBeenCalledTimes(64)
    expect(settled).toHaveBeenNthCalledWith(1, {
      clientMessageId: 'client-0',
      state: 'rejected',
      reason: 'provider_cancelled_before_start'
    })
  })

  it('rejects an ambiguously written dispatch when a later interrupt confirms it was cancelled', async () => {
    let cancelledUuid = ''
    const { session } = sessionWith({
      capabilities: ['interrupt_cancel_queued_v1'],
      interrupt: async () => ({ still_queued: [], cancelled: [cancelledUuid] })
    })
    session.connection.send = vi.fn(async () => {
      throw new Error('connection lost after write')
    })
    const settled = vi.fn()

    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-ambiguous',
        body: userMessage([{ type: 'text', text: 'queued' }])
      })
    ).resolves.toMatchObject({ state: 'unknown' })
    expect(session.dispatchWaiters).toEqual([])
    expect(session.retiredDispatchWaiters).toHaveLength(1)
    cancelledUuid = session.retiredDispatchWaiters[0]!.sentUuid

    await expect(cancelClaudeTurn(session, 5_000, () => true, settled)).resolves.toEqual({
      cancelled: true
    })
    expect(session.retiredDispatchWaiters).toEqual([])
    expect(settled).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-ambiguous',
      state: 'rejected',
      reason: 'provider_cancelled_before_start'
    })
  })

  it('reports a not-running interrupt as not cancelled without throwing', async () => {
    const { session } = sessionWith({
      interrupt: async () => {
        throw new ClaudeControlRequestError('interrupt', 'not running')
      }
    })

    await expect(cancelClaudeTurn(session, 5_000)).resolves.toEqual({ cancelled: false })
  })

  it('propagates a transport failure such as an interrupt timeout', async () => {
    const { session } = sessionWith({
      interrupt: async () => {
        throw new Error('claude interrupt request timed out')
      }
    })

    await expect(cancelClaudeTurn(session, 5_000)).rejects.toThrow('timed out')
  })
})

describe('answerClaudePrompt', () => {
  it('resolves cancellation observation when teardown clears the prompt registry', async () => {
    const prompts = new ClaudePromptRegistry()
    const settle = vi.fn()
    const prompt = prompts.register({
      requestId: 'perm-clear',
      toolName: 'Bash',
      toolUseId: 'tool-clear',
      input: { command: 'ls' },
      suggestions: [],
      settle
    })!
    prompts.bindJournalItemId('journal-clear', prompt.promptKey)
    const claim = prompts.claim('journal-clear', 'approval')
    if (!claim) {
      throw new Error('expected prompt claim')
    }
    const observed = prompts.observeCancellation(claim)
    if (!observed) {
      throw new Error('expected cancellation observation')
    }
    let observedCancellation = false
    void observed.then(() => {
      observedCancellation = true
    })

    expect(prompts.clear()).toEqual([prompt])
    await Promise.resolve()

    expect(observedCancellation).toBe(true)
    expect(prompts.find('journal-clear')).toBeNull()
    expect(prompts.ownsClaim(claim)).toBe(false)
    expect(settle).not.toHaveBeenCalled()
  })

  it('settles the pending prompt callback and forgets it', async () => {
    const prompts = new ClaudePromptRegistry()
    const settle = vi.fn()
    const prompt = prompts.register({
      requestId: 'perm-1',
      toolName: 'Bash',
      toolUseId: 'tool-1',
      input: { command: 'ls' },
      suggestions: [],
      settle
    })!
    prompts.bindJournalItemId('journal-1', prompt.promptKey)
    const { session } = sessionWith({ interrupt: async () => undefined, prompts })
    const resolvePrompt = vi.fn()
    session.translator = {
      handle: vi.fn(),
      journalPrompts: {
        cancel: vi.fn(() => ({ accepted: true as const })),
        resolve: resolvePrompt
      },
      currentTurnId: null,
      flush: vi.fn(),
      pendingStreamedBlocks: 0,
      dispose: vi.fn()
    }

    const claim = prompts.claim('journal-1', 'approval')
    if (!claim) {
      throw new Error('expected prompt claim')
    }
    await answerClaudePrompt(session, claim, 'allow', async () => {})

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'allow', toolUseID: 'tool-1' })
    )
    expect(prompts.find('journal-1')).toBeNull()
    expect(resolvePrompt).toHaveBeenCalledWith(prompt.promptKey)
  })

  it('refuses to claim a prompt Claude is no longer waiting on', () => {
    const prompts = new ClaudePromptRegistry()
    expect(prompts.claim('missing', 'approval')).toBeNull()
  })
})

describe('stopClaudeBackgroundTasks', () => {
  it('stops each live SDK task id and never depends on an active turn id', async () => {
    const backgroundTasks = new ClaudeBackgroundTaskTracker()
    backgroundTasks.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'task-agent', task_type: 'local_agent', description: 'agent' },
        { task_id: 'task-bash', task_type: 'local_bash', description: 'bash' }
      ]
    })
    const stopTask = vi.fn(async (_taskId: string, _options?: { timeoutMs?: number }) => {})
    const session = { backgroundTasks, connection: { stopTask } } as unknown as ClaudeSession

    await expect(stopClaudeBackgroundTasks(session, 5_000)).resolves.toEqual({ cancelled: true })
    expect(stopTask.mock.calls).toEqual([
      ['task-agent', { timeoutMs: 5_000 }],
      ['task-bash', { timeoutMs: 5_000 }]
    ])
  })

  it('stops issuing requests when ownership changes between tasks', async () => {
    const backgroundTasks = new ClaudeBackgroundTaskTracker()
    for (const taskId of ['task-1', 'task-2']) {
      backgroundTasks.observe({
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        task_type: 'local_agent',
        is_backgrounded: true
      })
    }
    let current = true
    const stopTask = vi.fn(async (_taskId: string) => {
      current = false
    })
    const session = { backgroundTasks, connection: { stopTask } } as unknown as ClaudeSession

    await stopClaudeBackgroundTasks(session, undefined, () => current)
    expect(stopTask).toHaveBeenCalledTimes(1)
  })

  it('stops only the requested live task id', async () => {
    const backgroundTasks = new ClaudeBackgroundTaskTracker()
    backgroundTasks.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'task-one', task_type: 'local_agent' },
        { task_id: 'task-two', task_type: 'local_bash' }
      ]
    })
    const stopTask = vi.fn(async (_taskId: string) => {})
    const session = { backgroundTasks, connection: { stopTask } } as unknown as ClaudeSession

    await expect(
      stopClaudeBackgroundTasks(session, 5_000, () => true, 'task-two')
    ).resolves.toEqual({ cancelled: true })
    expect(stopTask).toHaveBeenCalledWith('task-two', { timeoutMs: 5_000 })
    expect(stopTask).toHaveBeenCalledTimes(1)
  })

  it('refuses a stale or unknown task id without a provider call', async () => {
    const backgroundTasks = new ClaudeBackgroundTaskTracker()
    backgroundTasks.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-live',
      task_type: 'local_agent',
      is_backgrounded: true
    })
    const stopTask = vi.fn(async (_taskId: string) => {})
    const session = { backgroundTasks, connection: { stopTask } } as unknown as ClaudeSession

    await expect(
      stopClaudeBackgroundTasks(session, undefined, () => true, 'task-stale')
    ).resolves.toEqual({ cancelled: false })
    expect(stopTask).not.toHaveBeenCalled()
  })
})
