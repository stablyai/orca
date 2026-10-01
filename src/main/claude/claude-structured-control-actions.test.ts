import { describe, expect, it, vi } from 'vitest'
import {
  cancelClaudeTurn,
  answerClaudePrompt,
  stopClaudeBackgroundTasks
} from './claude-structured-control-actions'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  ClaudeControlRequestTimeoutError,
  runClaudeControl
} from './claude-agent-sdk-control-requests'
import { buildClaudePromptReply, ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeDispatchWaiter, ClaudeSession } from './claude-structured-session-state'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { sessionFor, userMessage } from './claude-structured-dispatch-test-support'

type InterruptResult = Awaited<ReturnType<ClaudeSession['connection']['interrupt']>>

function sessionWith(input: {
  capabilities?: string[]
  interrupt: (options?: { cancelQueued?: boolean; timeoutMs?: number }) => Promise<InterruptResult>
  cancelAsyncMessage?: (uuid: string) => Promise<boolean>
  prompts?: ClaudePromptRegistry
}): {
  session: ClaudeSession
  interrupt: ReturnType<typeof vi.fn>
  cancelAsyncMessage: ReturnType<typeof vi.fn>
} {
  const interrupt = vi.fn(input.interrupt)
  const cancelAsyncMessage = vi.fn(input.cancelAsyncMessage ?? (async () => false))
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

  it('settles each still-queued send the CLI confirms it withdrew, and only those', async () => {
    const { session, cancelAsyncMessage } = sessionWith({
      capabilities: ['interrupt_receipt_v1'],
      interrupt: async () => ({ still_queued: ['queued-1', 'queued-2', 'queued-3'] }),
      // queued-2 already ran; queued-3's answer never arrived.
      cancelAsyncMessage: async (uuid) => {
        if (uuid === 'queued-3') {
          throw new ClaudeControlRequestError('cancel_async_message', 'timed out')
        }
        return uuid === 'queued-1'
      }
    })
    const resolutions = [vi.fn(), vi.fn(), vi.fn()]
    session.dispatchWaiters = ['queued-1', 'queued-2', 'queued-3'].map(
      (sentUuid, index): ClaudeDispatchWaiter => ({
        acceptsResult: false,
        clientMessageId: `client-${index + 1}`,
        sentUuid,
        dispatchSequence: index + 1,
        requestedAt: null,
        replayContentKey: `content-${index}`,
        resolve: resolutions[index]!
      })
    )
    const settled = vi.fn()

    await expect(cancelClaudeTurn(session, 5_000, () => true, settled)).resolves.toEqual({
      cancelled: true
    })
    expect(cancelAsyncMessage).toHaveBeenCalledTimes(3)
    expect(settled.mock.calls).toEqual([
      [
        {
          clientMessageId: 'client-1',
          state: 'rejected',
          reason: 'provider_cancelled_before_start',
          rejection: { kind: 'cancelled' }
        }
      ]
    ])
    expect(resolutions[0]).toHaveBeenCalledWith(null)
    expect(session.dispatchWaiters.map((waiter) => waiter.sentUuid)).toEqual([
      'queued-2',
      'queued-3'
    ])
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
      reason: 'provider_cancelled_before_start',
      rejection: { kind: 'cancelled' }
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
      reason: 'provider_cancelled_before_start',
      rejection: { kind: 'cancelled' }
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
      openTurnInLiveProviderCycle: false,
      journalPrompts: {
        cancel: vi.fn(() => ({ accepted: true as const })),
        resolve: resolvePrompt
      },
      currentTurnId: null,
      recordTurnStop: () => true,
      withdrawTurnStop: () => {},
      commandTurnId: null,
      beginCommand: vi.fn(),
      forgetCommand: vi.fn(),
      commandInterruptRequested: vi.fn(),
      flush: vi.fn(),
      contextActivity: 0,
      markContextActivity: vi.fn(),
      subscribeContextUsageRequests: () => () => {},
      recordContextReport: () => {},
      modelMayHaveChanged: () => {},
      modelWritten: () => {},
      pendingStreamedBlocks: 0,
      dispose: vi.fn()
    }

    const claim = prompts.claim('journal-1', 'approval')
    if (!claim) {
      throw new Error('expected prompt claim')
    }
    await answerClaudePrompt(
      session,
      claim,
      buildClaudePromptReply(prompt, { kind: 'option', optionId: 'allow' })
    )

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
  /** A decoder holding `ids` live, as backgrounded agents. */
  function liveChildWork(ids: string[]): ClaudeChildWorkDecoder {
    const childWork = new ClaudeChildWorkDecoder()
    for (const id of ids) {
      childWork.observe({
        type: 'system',
        subtype: 'task_started',
        task_id: id,
        task_type: 'local_agent',
        is_backgrounded: true
      })
    }
    childWork.drain(1)
    return childWork
  }

  function stoppingSession(
    childWork: ClaudeChildWorkDecoder,
    stopTask: (taskId: string, options?: { timeoutMs?: number }) => Promise<void>
  ): ClaudeSession {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a background stop reads only the session's child-work decoder and its connection's stopTask.
    return { childWork, connection: { stopTask } } as unknown as ClaudeSession
  }

  it('stops exactly the ids the host named, and ends each acknowledged one', async () => {
    const childWork = liveChildWork(['task-agent', 'task-bash'])
    const stopTask = vi.fn(async (_taskId: string, _options?: { timeoutMs?: number }) => {})
    const session = stoppingSession(childWork, stopTask)

    await expect(
      stopClaudeBackgroundTasks(session, 5_000, () => true, ['task-agent', 'task-bash'])
    ).resolves.toEqual({ cancelled: true })
    expect(stopTask.mock.calls).toEqual([
      ['task-agent', { timeoutMs: 5_000 }],
      ['task-bash', { timeoutMs: 5_000 }]
    ])
    expect(childWork.drain(2)).toEqual([
      {
        type: 'ended',
        observedAt: 2,
        handle: { idKind: 'task_id', id: 'task-agent' },
        outcome: 'cancelled',
        basis: 'stop-acknowledged'
      },
      {
        type: 'ended',
        observedAt: 2,
        handle: { idKind: 'task_id', id: 'task-bash' },
        outcome: 'cancelled',
        basis: 'stop-acknowledged'
      }
    ])
  })

  it('stops issuing requests when ownership changes between tasks', async () => {
    const childWork = liveChildWork(['task-1', 'task-2'])
    let current = true
    const stopTask = vi.fn(async (_taskId: string) => {
      current = false
    })
    const session = stoppingSession(childWork, stopTask)

    await stopClaudeBackgroundTasks(session, undefined, () => current, ['task-1', 'task-2'])
    expect(stopTask).toHaveBeenCalledTimes(1)
  })

  it('leaves a task live when the CLI refuses its stop, and makes no call for no ids', async () => {
    const childWork = liveChildWork(['task-live'])
    const stopTask = vi.fn(async (_taskId: string) => {
      throw new ClaudeControlRequestError('stop_task', 'Task task-live is owned by another agent')
    })
    const session = stoppingSession(childWork, stopTask)

    await expect(
      stopClaudeBackgroundTasks(session, undefined, () => true, ['task-live'])
    ).resolves.toEqual({ cancelled: false })
    expect(childWork.drain(2)).toEqual([])
    await expect(stopClaudeBackgroundTasks(session, undefined, () => true, [])).resolves.toEqual({
      cancelled: false
    })
    expect(stopTask).toHaveBeenCalledTimes(1)
  })

  it('stops the remaining tasks after one request fails, then reports the failure', async () => {
    const childWork = liveChildWork(['task-1', 'task-2'])
    const lost = new Error('connection reset')
    const stopTask = vi.fn(async (taskId: string) => {
      if (taskId === 'task-1') {
        throw lost
      }
    })
    const session = stoppingSession(childWork, stopTask)

    await expect(
      stopClaudeBackgroundTasks(session, undefined, () => true, ['task-1', 'task-2'])
    ).rejects.toBe(lost)
    expect(stopTask.mock.calls.map(([taskId]) => taskId)).toEqual(['task-1', 'task-2'])
    expect(childWork.drain(2)).toMatchObject([
      { type: 'ended', handle: { id: 'task-2' }, outcome: 'cancelled' }
    ])
  })

  it('stops asking after a request times out: a CLI not answering costs one deadline, not one per task', async () => {
    const childWork = liveChildWork(['task-0', 'task-1', 'task-2', 'task-3', 'task-4'])
    // Never answered, behind the real deadline wrapper, with a short deadline.
    const stopTask = vi.fn((_taskId: string, options?: { timeoutMs?: number }) =>
      runClaudeControl('stop_task', () => new Promise<void>(() => {}), options?.timeoutMs)
    )
    const session = stoppingSession(childWork, stopTask)

    await expect(
      stopClaudeBackgroundTasks(session, 50, () => true, [
        'task-0',
        'task-1',
        'task-2',
        'task-3',
        'task-4'
      ])
    ).rejects.toBeInstanceOf(ClaudeControlRequestTimeoutError)
    expect(stopTask).toHaveBeenCalledTimes(1)
    expect(childWork.drain(2)).toEqual([])
  })
})
