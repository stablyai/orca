import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleKey
} from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './structured-agent-session-logger'
import type { StructuredAgentSessionConversationNaming } from './structured-agent-session-host-types'

type Occurrence = { record: AgentSessionRecord; name: string; sequence: number }
type Pending = { latest: Occurrence; done: Promise<void> }

/** Intent retains its committed context; a later clear or account choice cannot redirect it. */
export function createStructuredAgentSessionProviderNaming(deps: {
  adapter: Pick<
    StructuredAgentSessionAdapter,
    'renameProviderSession' | 'nameProviderConversation' | 'stopProviderNaming'
  >
  logger: StructuredAgentSessionLogger
}) {
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  const running = new Map<string, Pending>()
  const accepted = new Map<Promise<void>, Promise<void>>()
  let sequence = 0
  let stopped = false
  const warn = (record: AgentSessionRecord, error: unknown): void => {
    logger.warn('naming the agent conversation after a chat rename failed', {
      scope: 'provider-session-rename',
      sessionId: record.sessionId,
      error
    })
  }
  const track = (record: AgentSessionRecord, effect: Promise<void>): Promise<void> => {
    const existing = accepted.get(effect)
    if (existing) {
      return existing
    }
    const done = effect
      .catch((error: unknown) => warn(record, error))
      .finally(() => accepted.delete(effect))
    accepted.set(effect, done)
    return done
  }
  const drain = async (key: string, entry: Pending): Promise<void> => {
    try {
      for (;;) {
        const occurrence = entry.latest
        const head = agentSessionProviderHandleChainHead(occurrence.record.providerHandleChain)
        if (head) {
          try {
            await deps.adapter.renameProviderSession?.({
              record: occurrence.record,
              providerSessionId: head.handle.nativeId,
              name: occurrence.name
            })
          } catch (error) {
            warn(occurrence.record, error)
          }
        }
        if (entry.latest === occurrence) {
          return
        }
      }
    } finally {
      running.delete(key)
    }
  }
  return {
    push(record: AgentSessionRecord, inheritance = false): Promise<void> {
      if (stopped) {
        return Promise.resolve()
      }
      if (record.conversationNameSource !== 'user' || !record.conversationName) {
        return Promise.resolve()
      }
      const occurrence = {
        record,
        name: record.conversationName,
        sequence: ++sequence,
        inheritance
      }
      try {
        const captured = deps.adapter.nameProviderConversation?.(occurrence)
        if (captured) {
          return track(record, captured)
        }
      } catch (error) {
        warn(record, error)
        return Promise.resolve()
      }
      const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
      if (!head) {
        return Promise.resolve()
      }
      const key = JSON.stringify([
        record.sessionId,
        agentSessionProviderHandleKey(head.handle),
        record.accountHome
      ])
      const current = running.get(key)
      if (current) {
        current.latest = occurrence
        return current.done
      }
      const entry = { latest: occurrence, done: Promise.resolve() }
      running.set(key, entry)
      entry.done = track(record, drain(key, entry))
      return entry.done
    },
    async stop(): Promise<void> {
      stopped = true
      deps.adapter.stopProviderNaming?.()
      await Promise.all(accepted.values())
    }
  }
}

/** Capture inside the applied commit, after canonical publication, without changing RPC output. */
export function withProviderNaming(
  naming: StructuredAgentSessionConversationNaming,
  nameProvider: (record: AgentSessionRecord) => void
): StructuredAgentSessionConversationNaming {
  return {
    ...naming,
    setUserName: (sessionId, name, write, onApplied) =>
      naming.setUserName(sessionId, name, write, (record) => {
        nameProvider(record)
        onApplied?.(record)
      })
  }
}
