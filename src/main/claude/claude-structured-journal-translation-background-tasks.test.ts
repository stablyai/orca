import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget,
  type StructuredAgentSessionLifecycleJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

// The frames below are the ones the reported session actually carried: two real
// failures that printed THREE red rows whose visible text was the wire opcode,
// two of them for the same task.
const TASK_ID = 'byjnee2no'
const SUMMARY = 'Background command "Wait for the verification verdict" failed with exit code 1'

function orcaClientMessageId(identity: AgentJournalItemIdentity): string | null {
  return identity.provider === 'orca' ? identity.clientMessageId : null
}

function harness() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: vi.fn(),
    publish: vi.fn()
  }
  const translator = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'test' })
  const rowsWithPrefix = (prefix: string): AgentJournalItemBody[] =>
    items
      .filter((item) => (orcaClientMessageId(item.identity) ?? '').startsWith(prefix))
      .map((item) => item.body)
  const textOf = (body: AgentJournalItemBody): string => {
    if (body.kind === 'status') {
      return body.text
    }
    return body.kind === 'message'
      ? body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ')
      : ''
  }
  return {
    translator,
    items,
    /** Generic unknown-frame rows — the ones that printed `claude · <opcode>`. */
    fallbackRows: () => rowsWithPrefix('provider-frame:').map(textOf),
    taskRowIds: () =>
      items
        .map((item) => orcaClientMessageId(item.identity) ?? '')
        .filter((id) => id.startsWith('claude-background-task:')),
    taskRowTexts: () => rowsWithPrefix('claude-background-task:').map(textOf)
  }
}

function systemFrame(fields: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: { type: 'system', session_id: 'claude-session', ...fields }
  }
}

/** The assistant turn that invokes the spawn tool. Admission consults it: a task
 *  whose spawning tool never reached the transcript is a nested child, so every
 *  realistic sequence forwards this first. */
function spawnToolCall(
  translator: ReturnType<typeof harness>['translator'],
  toolUseId = 'toolu_01CqPd7y'
): void {
  translator.handle({
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'assistant',
      uuid: `assistant-${toolUseId}`,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'wait' } }]
      }
    }
  })
}

function playFailedBackgroundCommand(translator: ReturnType<typeof harness>['translator']): void {
  spawnToolCall(translator)
  translator.handle(
    systemFrame({
      subtype: 'task_started',
      task_id: TASK_ID,
      tool_use_id: 'toolu_01CqPd7y',
      task_type: 'local_bash',
      description: 'Wait for the verification verdict',
      is_backgrounded: true
    })
  )
  translator.handle(
    systemFrame({
      subtype: 'task_updated',
      task_id: TASK_ID,
      patch: { status: 'failed', end_time: 1_789_332_035_695 }
    })
  )
  translator.handle(
    systemFrame({
      subtype: 'task_notification',
      task_id: TASK_ID,
      tool_use_id: 'toolu_01CqPd7y',
      status: 'failed',
      output_file: '/private/tmp/claude-501/tasks/byjnee2no.output',
      summary: SUMMARY
    })
  )
}

function persistedTarget(
  persisted: Map<string, AgentJournalItemBody>
): StructuredAgentSessionEventTarget {
  const journal =
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test double implements the journal methods exercised by the deferred sink.
    {
      appendItem: async (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
        persisted.set(agentJournalItemKey(identity), body)
        return { cursor: { epoch: 'test', sequence: persisted.size }, itemId: '', revision: 1 }
      },
      appendTombstone: vi.fn(),
      visitItems: (
        visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
      ) => {
        for (const [itemId, body] of persisted) {
          visit(itemId, 0, body)
        }
      },
      epoch: 'test'
    } as unknown as AgentSessionJournal
  return { journal, fence: 1, publish: vi.fn() }
}

describe('claude journal translation — background task rows', () => {
  it('resolves a queued restart identity after the sink rebinds', async () => {
    const persisted = new Map<string, AgentJournalItemBody>()
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.bind(persistedTarget(persisted))

    const first = createClaudeJournalTranslator({ sink: deferred.sink, fallbackIdPrefix: 'first' })
    spawnToolCall(first, 'toolu-first')
    first.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'queued-restart',
        tool_use_id: 'toolu-first',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )
    await deferred.drained()
    first.dispose()
    await deferred.drained()

    const restarted = createDeferredStructuredAgentSessionEventSink()
    const second = createClaudeJournalTranslator({
      sink: restarted.sink,
      fallbackIdPrefix: 'second'
    })
    spawnToolCall(second, 'toolu-second')
    second.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'queued-restart',
        tool_use_id: 'toolu-second',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )
    restarted.bind(persistedTarget(persisted))
    await restarted.drained()

    expect([...persisted.keys()].filter((key) => key.includes('queued-restart'))).toEqual([
      'orca:claude-background-task%3Aqueued-restart',
      'orca:claude-background-task%3Aqueued-restart%232'
    ])
  })

  it('keeps pending writes from distinct runs when a translator is recreated', async () => {
    const persisted = new Map<string, AgentJournalItemBody>()
    const deferred = createDeferredStructuredAgentSessionEventSink()

    const first = createClaudeJournalTranslator({ sink: deferred.sink, fallbackIdPrefix: 'first' })
    spawnToolCall(first, 'toolu-first')
    first.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'queued-overlap',
        tool_use_id: 'toolu-first',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )
    first.dispose()

    const second = createClaudeJournalTranslator({
      sink: deferred.sink,
      fallbackIdPrefix: 'second'
    })
    spawnToolCall(second, 'toolu-second')
    second.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'queued-overlap',
        tool_use_id: 'toolu-second',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )

    deferred.bind(persistedTarget(persisted))
    await deferred.drained()

    expect([...persisted.keys()].filter((key) => key.includes('queued-overlap'))).toEqual([
      'orca:claude-background-task%3Aqueued-overlap',
      'orca:claude-background-task%3Aqueued-overlap%232'
    ])
  })

  it('does not overwrite a prior run when a new translator sees a reused task id', () => {
    const persisted = new Map<string, AgentJournalItemBody>()
    const journal: StructuredAgentSessionLifecycleJournal = {
      epoch: '',
      visitItems: (visit) => {
        for (const [itemId, body] of persisted) {
          visit(itemId, 0, body)
        }
      }
    }
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (identity, body) => persisted.set(agentJournalItemKey(identity), body),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      tryAppendResolvedItem: (_identitySizeBound, body, resolveIdentity) => {
        const identity = resolveIdentity(journal)
        if (identity) {
          persisted.set(agentJournalItemKey(identity), body)
        }
        return { accepted: true }
      }
    }
    const first = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'first' })
    spawnToolCall(first, 'toolu-first')
    first.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'reused-after-reconnect',
        tool_use_id: 'toolu-first',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )
    first.handle(
      systemFrame({
        subtype: 'task_notification',
        task_id: 'reused-after-reconnect',
        tool_use_id: 'toolu-first',
        status: 'failed',
        summary: 'first run failed'
      })
    )
    first.dispose()

    const resumed = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'resumed' })
    spawnToolCall(resumed, 'toolu-first')
    resumed.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'reused-after-reconnect',
        tool_use_id: 'toolu-first',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )
    expect([...persisted.keys()].filter((key) => key.includes('reused-after-reconnect'))).toEqual([
      'orca:claude-background-task%3Areused-after-reconnect'
    ])
    resumed.dispose()

    const second = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'second' })
    spawnToolCall(second, 'toolu-second')
    second.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'reused-after-reconnect',
        tool_use_id: 'toolu-second',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )

    const rows = [...persisted.entries()].filter(([key]) => key.includes('reused-after-reconnect'))
    expect(rows.map(([key]) => key)).toEqual([
      'orca:claude-background-task%3Areused-after-reconnect',
      'orca:claude-background-task%3Areused-after-reconnect%232'
    ])
  })

  it('prints the provider sentence once instead of the opcode twice', () => {
    const { translator, fallbackRows, taskRowIds, taskRowTexts } = harness()
    playFailedBackgroundCommand(translator)

    // ABLATION: drop `message:system:task_*` from CLAUDE_TYPED_TRANSLATOR_KINDS
    // and this is `['claude · message:system:task_updated', 'claude ·
    // message:system:task_notification']` — the reported bug exactly.
    expect(fallbackRows()).toEqual([])
    // One durable row for one task, however many frames reported it.
    expect(new Set(taskRowIds())).toEqual(new Set([`claude-background-task:${TASK_ID}`]))
    expect(taskRowTexts().at(-1)).toBe(SUMMARY)
  })

  it('keeps the aggregate roster frame off the transcript even when it carries a failure', () => {
    const { translator, fallbackRows, taskRowIds } = harness()
    translator.handle(
      systemFrame({
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: TASK_ID, status: 'failed', task_type: 'local_bash' }]
      })
    )
    // It promotes through the payload sniffer exactly as the per-task frames do,
    // and it creates no row of its own: the task's own frames own that.
    expect(fallbackRows()).toEqual([])
    expect(taskRowIds()).toEqual([])
  })

  it('still surfaces an unmodelled failed frame through the generic fallback', () => {
    const { translator, fallbackRows } = harness()
    translator.handle(systemFrame({ subtype: 'future_event', status: 'failed' }))
    // The coverage contract is per-kind, so nothing about it weakens the payload
    // sniffer for the kinds nobody has modelled.
    expect(fallbackRows()).toEqual(['claude · message:system:future_event'])
  })

  it('falls back visibly when a malformed task frame reports a failure', () => {
    const { translator, fallbackRows, taskRowIds } = harness()
    translator.handle(
      systemFrame({
        subtype: 'task_notification',
        status: 'failed',
        summary: 'Background command "Wait" failed with exit code 1'
      })
    )

    expect(taskRowIds()).toEqual([])
    expect(fallbackRows()).toEqual(['Background command "Wait" failed with exit code 1'])
  })

  it('keeps a refused live task failure visible through the generic fallback', () => {
    const { translator, fallbackRows } = harness()
    for (let index = 0; index < 64; index += 1) {
      const toolUseId = `toolu-live-${index}`
      spawnToolCall(translator, toolUseId)
      translator.handle(
        systemFrame({
          subtype: 'task_started',
          task_id: `live-${index}`,
          tool_use_id: toolUseId,
          task_type: 'local_bash',
          description: `live ${index}`,
          is_backgrounded: true
        })
      )
    }

    spawnToolCall(translator, 'toolu-overflow')
    translator.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'overflow-fallback',
        tool_use_id: 'toolu-overflow',
        task_type: 'local_bash',
        description: 'overflow task',
        is_backgrounded: true
      })
    )
    translator.handle(
      systemFrame({
        subtype: 'task_updated',
        task_id: 'overflow-fallback',
        patch: { status: 'failed' }
      })
    )
    translator.handle(
      systemFrame({
        subtype: 'task_notification',
        task_id: 'overflow-fallback',
        tool_use_id: 'toolu-overflow',
        status: 'failed',
        summary: 'overflow failed'
      })
    )
    translator.handle(
      systemFrame({
        subtype: 'task_progress',
        task_id: 'overflow-fallback',
        usage: { total_tokens: 3 }
      })
    )
    translator.handle(
      systemFrame({
        subtype: 'task_notification',
        task_id: 'overflow-fallback',
        status: 'failed',
        summary: 'duplicate overflow failed'
      })
    )

    expect(fallbackRows().at(-1)).toBe('overflow failed')
    expect(fallbackRows().at(-2)).toBe('Background task failed')
    expect(fallbackRows().at(-2)).not.toContain('message:system:task_')
    expect(fallbackRows()).toHaveLength(2)
  })

  it('settles live background rows when the provider ends before disposal', () => {
    const { translator, taskRowTexts } = harness()
    spawnToolCall(translator)
    translator.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: TASK_ID,
        tool_use_id: 'toolu_01CqPd7y',
        task_type: 'local_bash',
        description: 'Wait for the verification verdict',
        is_backgrounded: true
      })
    )

    translator.handle({ type: 'ended', sessionId: 'orca-session', reason: 'closed' })

    expect(taskRowTexts().at(-1)).toBe(
      'Background command "Wait for the verification verdict" stopped reporting'
    )
  })
  it('keeps a nested child spawned inside a sidechain off the top-level transcript', () => {
    const { translator, taskRowIds, fallbackRows } = harness()
    // The spawn tool call is emitted by a SUBAGENT, so it carries a parent tool
    // id and is never a top-level invocation.
    translator.handle({
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'assistant',
        uuid: 'nested-assistant',
        session_id: 'claude-session',
        parent_tool_use_id: 'toolu_parent_agent',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_sidechain', name: 'Bash', input: { command: 'wait' } }
          ]
        }
      }
    })
    translator.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'nested-1',
        tool_use_id: 'toolu_sidechain',
        task_type: 'local_bash',
        description: 'nested work',
        is_backgrounded: true
      })
    )
    translator.handle(
      systemFrame({
        subtype: 'task_notification',
        task_id: 'nested-1',
        tool_use_id: 'toolu_sidechain',
        status: 'failed',
        summary: 'nested child failed'
      })
    )

    expect(taskRowIds()).toEqual([])
    expect(fallbackRows()).toEqual([])
  })

  it('keeps a monitor off the timeline entirely', () => {
    const { translator, taskRowIds, fallbackRows } = harness()
    spawnToolCall(translator)
    translator.handle(
      systemFrame({
        subtype: 'task_started',
        task_id: 'monitor-1',
        tool_use_id: 'toolu_01CqPd7y',
        task_type: 'monitor',
        description: 'Watch the build',
        is_backgrounded: true
      })
    )
    translator.handle(
      systemFrame({
        subtype: 'task_notification',
        task_id: 'monitor-1',
        tool_use_id: 'toolu_01CqPd7y',
        status: 'failed',
        summary: 'monitor stopped'
      })
    )

    expect(taskRowIds()).toEqual([])
    expect(fallbackRows()).toEqual([])
  })
})
