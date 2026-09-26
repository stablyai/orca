import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { describe, expect, it, vi } from 'vitest'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionLifecycleJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeBackgroundTaskRow } from './claude-background-task-row-lifecycle'
import {
  ClaudeBackgroundTaskIdentityResolver,
  writeClaudeBackgroundTaskRow
} from './claude-background-task-row-journal'
import { ClaudeBackgroundTaskRows } from './claude-background-task-rows'
import { START_BASH } from './claude-background-task-row-test-support'

function journal(
  epoch: () => string,
  visitItems = vi.fn()
): StructuredAgentSessionLifecycleJournal {
  return {
    get epoch() {
      return epoch()
    },
    visitItems
  }
}

function row(): ClaudeBackgroundTaskRow {
  return {
    block: {
      type: 'background-task',
      taskId: 'task-1',
      kind: 'command',
      label: 'Build',
      state: 'blocked',
      error: 'exit 1'
    },
    lastSerialized: null,
    toolUseId: 'tool-1',
    terminalNotificationReceived: true,
    generation: 1
  }
}

describe('Claude background task row journal', () => {
  it('resolves one immutable run once per journal epoch', () => {
    let epoch = 'epoch-1'
    const visits = vi.fn()
    const firstJournal = journal(() => epoch, visits)
    const resolver = new ClaudeBackgroundTaskIdentityResolver()

    for (let revision = 0; revision < 100; revision += 1) {
      resolver.resolve(firstJournal, 'task-1', 'tool-1')
    }
    expect(visits).toHaveBeenCalledOnce()

    resolver.resolve(firstJournal, 'task-1', 'tool-2')
    expect(visits).toHaveBeenCalledTimes(2)

    epoch = 'epoch-2'
    resolver.resolve(firstJournal, 'task-1', 'tool-1')
    expect(visits).toHaveBeenCalledTimes(3)

    resolver.resolve(
      journal(() => 'epoch-2', visits),
      'task-1',
      'tool-1'
    )
    expect(visits).toHaveBeenCalledTimes(4)
  })

  it('bounds resolved run identities with LRU eviction', () => {
    const visits = vi.fn()
    const boundJournal = journal(() => 'epoch-1', visits)
    const resolver = new ClaudeBackgroundTaskIdentityResolver()

    for (let index = 0; index < 513; index += 1) {
      resolver.resolve(boundJournal, `task-${index}`, `tool-${index}`)
    }
    resolver.resolve(boundJournal, 'task-0', 'tool-0')

    expect(visits).toHaveBeenCalledTimes(514)
  })

  it('records a revision only after its append and publication are admitted', () => {
    const task = row()
    const appendAndPublish = vi
      .fn()
      .mockReturnValueOnce({ accepted: false, reason: 'backpressure' })
      .mockReturnValueOnce({ accepted: true })
    const sink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendResolvedItemAndPublish: appendAndPublish
    }
    const resolver = new ClaudeBackgroundTaskIdentityResolver()

    expect(
      writeClaudeBackgroundTaskRow(sink, resolver, 'task-1', task, () => AGENT_JOURNAL_THREAD_SCOPE)
    ).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    expect(task.lastSerialized).toBeNull()
    expect(
      writeClaudeBackgroundTaskRow(sink, resolver, 'task-1', task, () => AGENT_JOURNAL_THREAD_SCOPE)
    ).toEqual({
      accepted: true
    })
    expect(task.lastSerialized).not.toBeNull()
    expect(appendAndPublish).toHaveBeenCalledTimes(2)
  })

  it('keeps fallback append coalescing separate from its ordered publication', () => {
    const calls: { operation: 'append' | 'publish'; coalescingKey?: string }[] = []
    const task = row()
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendResolvedItem: vi.fn((_identity, _body, _resolve, options) => {
        calls.push({
          operation: 'append',
          ...(options?.coalescingKey ? { coalescingKey: options.coalescingKey } : {})
        })
        return { accepted: true as const }
      }),
      tryPublish: vi.fn((options) => {
        calls.push({
          operation: 'publish',
          ...(options?.coalescingKey ? { coalescingKey: options.coalescingKey } : {})
        })
        return { accepted: true as const }
      })
    }

    expect(
      writeClaudeBackgroundTaskRow(
        sink,
        new ClaudeBackgroundTaskIdentityResolver(),
        'task-1',
        task,
        () => AGENT_JOURNAL_THREAD_SCOPE
      )
    ).toEqual({ accepted: true })
    expect(calls).toEqual([
      {
        operation: 'append',
        coalescingKey: JSON.stringify(['claude-background-task', 'task-1', 'tool-1'])
      },
      { operation: 'publish' }
    ])
    expect(task.lastSerialized).not.toBeNull()
  })

  it('uses reserved lifecycle capacity when provider exit settles a live row', () => {
    const appendAndPublish = vi.fn<
      NonNullable<StructuredAgentSessionEventSink['tryAppendResolvedItemAndPublish']>
    >(() => ({ accepted: true as const }))
    const rows = new ClaudeBackgroundTaskRows({
      sink: {
        appendItem: vi.fn(),
        appendTombstone: vi.fn(),
        publish: vi.fn(),
        tryAppendResolvedItemAndPublish: appendAndPublish
      },
      isForwardedParentTool: () => true,
      turnScope: () => AGENT_JOURNAL_THREAD_SCOPE
    })

    rows.observe(START_BASH)
    rows.settleSession()

    expect(appendAndPublish).toHaveBeenCalledTimes(2)
    expect(appendAndPublish.mock.calls[1]?.[3]).toMatchObject({ lifecycle: true })
  })

  it('promotes a backpressured terminal row to lifecycle capacity on provider exit', () => {
    const appendAndPublish = vi
      .fn<NonNullable<StructuredAgentSessionEventSink['tryAppendResolvedItemAndPublish']>>()
      .mockReturnValueOnce({ accepted: false, reason: 'backpressure' })
      .mockReturnValueOnce({ accepted: true })
    const rows = new ClaudeBackgroundTaskRows({
      sink: {
        appendItem: vi.fn(),
        appendTombstone: vi.fn(),
        publish: vi.fn(),
        tryAppendResolvedItemAndPublish: appendAndPublish
      },
      isForwardedParentTool: () => true,
      turnScope: () => AGENT_JOURNAL_THREAD_SCOPE
    })

    rows.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'terminal-at-exit',
      status: 'failed',
      summary: 'failed'
    })
    rows.settleSession()

    expect(appendAndPublish).toHaveBeenCalledTimes(2)
    expect(appendAndPublish.mock.calls[1]?.[3]).toMatchObject({ lifecycle: true })
  })

  it('retries a refused row before later provider messages are read', () => {
    const appendAndPublish = vi
      .fn()
      .mockReturnValueOnce({ accepted: false, reason: 'backpressure' })
      .mockReturnValueOnce({ accepted: true })
    const rows = new ClaudeBackgroundTaskRows({
      sink: {
        appendItem: vi.fn(),
        appendTombstone: vi.fn(),
        publish: vi.fn(),
        tryAppendResolvedItemAndPublish: appendAndPublish
      },
      isForwardedParentTool: () => true,
      turnScope: () => AGENT_JOURNAL_THREAD_SCOPE
    })

    expect(rows.observe(START_BASH)).toBe(true)
    expect(rows.retryPendingWrites()).toEqual({ accepted: true })
    expect(appendAndPublish).toHaveBeenCalledTimes(2)
    expect(rows.retryPendingWrites()).toEqual({ accepted: true })
    expect(appendAndPublish).toHaveBeenCalledTimes(2)
  })

  it('abandons a permanently failed retry and reports recovery instead of latching', () => {
    const onPersistenceFailure = vi.fn()
    const appendAndPublish = vi
      .fn()
      .mockReturnValueOnce({ accepted: false, reason: 'backpressure' })
      .mockReturnValueOnce({ accepted: false, reason: 'failed' })
    const rows = new ClaudeBackgroundTaskRows({
      sink: {
        appendItem: vi.fn(),
        appendTombstone: vi.fn(),
        publish: vi.fn(),
        tryAppendResolvedItemAndPublish: appendAndPublish
      },
      isForwardedParentTool: () => true,
      onPersistenceFailure,
      turnScope: () => AGENT_JOURNAL_THREAD_SCOPE
    })

    rows.observe(START_BASH)
    expect(rows.retryPendingWrites()).toEqual({ accepted: false, reason: 'failed' })
    expect(onPersistenceFailure).toHaveBeenCalledOnce()
    expect(rows.retryPendingWrites()).toEqual({ accepted: true })
  })

  it('hands retry-capacity exhaustion to session recovery without throwing', () => {
    const onPersistenceFailure = vi.fn()
    const rows = new ClaudeBackgroundTaskRows({
      sink: {
        appendItem: vi.fn(),
        appendTombstone: vi.fn(),
        publish: vi.fn(),
        tryAppendResolvedItemAndPublish: vi.fn(() => ({
          accepted: false as const,
          reason: 'backpressure' as const
        }))
      },
      isForwardedParentTool: () => true,
      onPersistenceFailure,
      turnScope: () => AGENT_JOURNAL_THREAD_SCOPE
    })

    for (let index = 0; index < 512; index += 1) {
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: `task-${index}`,
        status: 'failed',
        summary: 'failed'
      })
    }
    expect(() => {
      rows.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-overflow',
        status: 'failed',
        summary: 'failed'
      })
    }).not.toThrow()
    expect(onPersistenceFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'claude background task journal retry capacity exhausted'
      })
    )
  })

  it.each(['closed', 'failed'] as const)('surfaces a %s sink refusal', (reason) => {
    const task = row()
    const sink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendResolvedItemAndPublish: vi.fn(() => ({ accepted: false as const, reason }))
    }

    expect(
      writeClaudeBackgroundTaskRow(
        sink,
        new ClaudeBackgroundTaskIdentityResolver(),
        'task-1',
        task,
        () => AGENT_JOURNAL_THREAD_SCOPE
      )
    ).toEqual({ accepted: false, reason })
    expect(task.lastSerialized).toBeNull()
  })
})
