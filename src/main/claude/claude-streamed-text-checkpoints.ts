import type {
  ClaudeStreamedTextCheckpointDeps,
  ClaudeStreamedTextCheckpoints,
  ClaudeStreamedTextSelection,
  ClaudePreparedTextEnd
} from './claude-streamed-text-contracts'
export type {
  ClaudeStreamedTextCheckpointDeps,
  ClaudeStreamedTextCheckpoints,
  ClaudeStreamedBlockEnd,
  ClaudePreparedTextEnd
} from './claude-streamed-text-contracts'
import {
  claudeStreamedTextStep,
  appendClaudePreparedSteps,
  appendClaudeStreamedWhole
} from './claude-streamed-terminal'
import { appendStructuredAgentSessionTextWindow } from '../native-chat/agent-session-wire/structured-agent-session-text-append'
import { claudeStreamingMessageBody } from './claude-structured-item-translation'
import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import type {
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaWindow,
  type AgentSessionDeltaCoalescerDeps
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

/**
 * Growth of a streamed block's row between its deltas and its final frame.
 *
 * Windows share one cadence; whole values remain available for finalization.
 */
function sameLinkage(
  left: StructuredAgentSessionAppendOptions,
  right: StructuredAgentSessionAppendOptions
): boolean {
  return (
    left.agentId === right.agentId &&
    left.parentAgentId === right.parentAgentId &&
    left.providerParentRef === right.providerParentRef &&
    left.producerKind === right.producerKind &&
    left.attempt === right.attempt
  )
}

export function createClaudeStreamedTextCheckpoints(
  deps: ClaudeStreamedTextCheckpointDeps
): ClaudeStreamedTextCheckpoints {
  const records = new Map<
    string,
    {
      identity: AgentJournalItemIdentity
      scope: string | null
      written?: StructuredAgentSessionAppendOptions
      startedAt?: number
    }
  >()

  /** Resolve each checkpoint afresh; later announcements revise provisional producers on the same row. */
  const producerOptions = (key: string): StructuredAgentSessionAppendOptions => {
    const scope = records.get(key)?.scope ?? null
    if (scope === null) {
      return {}
    }
    return agentJournalLinkageFields(deps.producer.settledLinkageFor(scope).linkage)
  }

  const persist = (key: string, text: string): boolean => {
    const record = records.get(key)
    if (!record) {
      return true
    }
    const options = producerOptions(key)
    if (deps.persist(record.identity, text, options) === false) {
      return false
    }
    record.written = options
    return true
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    ...(deps.source
      ? {
          source: (key: string) => {
            const record = records.get(key)
            return record ? deps.source?.(record.identity) : undefined
          }
        }
      : {}),
    ...(deps.coalesceMs === undefined ? {} : { windowMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    emit: (key, text) => persist(key, text),
    ...(deps.persistDelta
      ? {
          emitDelta: (key: string, window: AgentSessionDeltaWindow) => {
            const record = records.get(key)
            const identity = record?.identity
            if (!identity) {
              return true
            }
            const options = producerOptions(key)
            const accepted = deps.persistDelta?.(identity, window, options) !== false
            if (accepted) {
              record.written = options
            }
            return accepted
          }
        }
      : {})
  })

  const drop = (key: string): void => {
    coalescer.forget(key)
    records.delete(key)
  }

  const prepareOne = (
    key: string,
    extra?: { identity: AgentJournalItemIdentity; text: string }
  ): ClaudePreparedTextEnd | undefined => {
    const record = records.get(key)
    if (!record) {
      return undefined
    }
    const window = coalescer.window(key)
    const held = extra && agentJournalItemKey(extra.identity) === key ? extra.text : ''
    return {
      identity: record.identity,
      startedAt: record.startedAt,
      scope: record.scope,
      get text() {
        return window && !window.source ? window.text() : undefined
      },
      hasText:
        (window?.hasText ?? (deps.source?.(record.identity)?.length ?? 0) > 0) ||
        held.trim().length > 0,
      options: producerOptions(key),
      step: (body, options, finish = true) =>
        claudeStreamedTextStep(deps, record.identity, window, held, body, options, finish),
      forget: () => drop(key)
    }
  }

  const prepareFinish = (
    only?: ClaudeStreamedTextSelection,
    extra?: { identity: AgentJournalItemIdentity; text: string }
  ): ClaudePreparedTextEnd[] =>
    [...records].flatMap(([key, record]) => {
      const block = !only || only(key, record) ? prepareOne(key, extra) : undefined
      return block ? [block] : []
    })

  return {
    prepareFinish,
    startedAt: (key) => records.get(key)?.startedAt,
    append: (identity, text, parentToolUseId = null, startedAt) => {
      const key = agentJournalItemKey(identity)
      if (!records.has(key)) {
        records.set(key, { identity, scope: parentToolUseId, startedAt })
      }
      return coalescer.append(key, text)
    },
    flush: () => {
      coalescer.flushAll()
    },
    reattribute: () => {
      for (const [key, record] of records) {
        const options = producerOptions(key)
        const written = record.written
        // Nothing resolved differently: a duplicate must not burn a revision.
        if (written && sameLinkage(written, options)) {
          continue
        }
        const block = prepareOne(key)
        if (
          block &&
          (deps.persistPrepared
            ? deps.persistPrepared(block)
            : block.text !== undefined &&
              deps.persist(record.identity, block.text, options) !== false)
        ) {
          coalescer.markFlushed(key)
          record.written = options
        }
      }
    },
    forget: drop,
    latest: (key) => coalescer.snapshot(key)?.text,
    finish: (ended, only) => {
      let accepted = true
      for (const block of prepareFinish(only)) {
        if (
          !(deps.persistPrepared
            ? deps.persistPrepared(block, ended)
            : block.text !== undefined &&
              deps.persist(block.identity, block.text, block.options, ended) !== false)
        ) {
          accepted = false
        } else {
          block.forget()
        }
      }
      return accepted
    },
    get pending() {
      return records.size
    },
    dispose: () => {
      coalescer.dispose()
      records.clear()
    }
  }
}

export function createClaudeStreamedTextAdmission(
  sink: StructuredAgentSessionEventSink,
  turnScope: () => AgentJournalTurnScope
): ClaudeStreamedTextCheckpointDeps['persistDelta'] {
  return (identity, window, options) =>
    appendStructuredAgentSessionTextWindow(sink, identity, claudeStreamingMessageBody(''), window, {
      ...options,
      turnScope: turnScope()
    })
}

export {
  appendClaudeStreamedWhole,
  claudeStreamedWholeStep,
  appendClaudeTerminalSteps
} from './claude-streamed-terminal'

export function createClaudeProseCheckpoints(
  deps: {
    sink: StructuredAgentSessionEventSink
    coalesceMs?: number
    schedule?: AgentSessionDeltaCoalescerDeps['schedule']
  },
  turnScope: () => AgentJournalTurnScope,
  producer: ClaudeSubagentLinkageSource
): ClaudeStreamedTextCheckpoints {
  return createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    producer,
    source: deps.sink.textSource,
    prepareText: deps.sink.prepareText,
    persistDelta: createClaudeStreamedTextAdmission(deps.sink, turnScope),
    persistPrepared: (block, ended) =>
      !deps.sink.prepareText && block.text !== undefined
        ? appendClaudeStreamedWhole(
            deps.sink,
            block.identity,
            claudeStreamingMessageBody(block.text),
            { ...block.options, turnScope: turnScope() }
          )
        : appendClaudePreparedSteps(deps.sink, [
            block.step(
              claudeStreamingMessageBody(''),
              {
                ...block.options,
                turnScope: turnScope()
              },
              ended !== undefined
            )
          ]),
    persist: (identity, text, options, ended) => {
      const body = claudeStreamingMessageBody(text)
      if (ended) {
        return appendClaudeStreamedWhole(deps.sink, identity, body, {
          ...options,
          turnScope: turnScope()
        })
      }
      deps.sink.appendItem(identity, body, { ...options, turnScope: turnScope() })
      deps.sink.publish()
      return undefined
    }
  })
}
