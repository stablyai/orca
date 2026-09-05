import { describe, expect, it, vi } from 'vitest'
import {
  cancelClaudeTurn,
  answerClaudePrompt,
  stopClaudeBackgroundTasks
} from './claude-structured-control-actions'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeSession } from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'

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
  const session = {
    capabilities: input.capabilities ?? [],
    prompts: input.prompts ?? new ClaudePromptRegistry(),
    connection: { interrupt, cancelAsyncMessage }
  } as unknown as ClaudeSession
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

  it('sends cancel_queued and never sweeps when the CLI advertises the capability', async () => {
    const { session, interrupt, cancelAsyncMessage } = sessionWith({
      capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
      interrupt: async () => ({ still_queued: [], cancelled: ['queued-1'] })
    })

    await expect(cancelClaudeTurn(session, 5_000)).resolves.toEqual({ cancelled: true })
    expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true, timeoutMs: 5_000 })
    expect(cancelAsyncMessage).not.toHaveBeenCalled()
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

    await answerClaudePrompt(session, { itemId: 'journal-1', kind: 'approval', optionId: 'allow' })

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'allow', toolUseID: 'tool-1' })
    )
    expect(prompts.find('journal-1')).toBeNull()
  })

  it('refuses an answer for a prompt Claude is no longer waiting on', async () => {
    const { session } = sessionWith({ interrupt: async () => undefined })
    await expect(
      answerClaudePrompt(session, { itemId: 'missing', kind: 'approval', optionId: 'allow' })
    ).rejects.toThrow(/no longer waiting/)
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
})
