import type { ScheduledMessage } from '../../../shared/scheduled-message-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type ScheduledMessagePersistenceRuntime = Pick<StoreRuntimeState, 'state'>

const scheduledMessagePersistenceContext = Symbol('ScheduledMessagePersistence')
type ScheduledMessagePersistenceContext = {
  runtime: ScheduledMessagePersistenceRuntime
  scheduling: WriteSchedulingOperations
}

export class ScheduledMessagePersistence {
  readonly [scheduledMessagePersistenceContext]: ScheduledMessagePersistenceContext

  constructor(runtime: ScheduledMessagePersistenceRuntime, scheduling: WriteSchedulingOperations) {
    this[scheduledMessagePersistenceContext] = { runtime, scheduling }
  }

  listScheduledMessages(): ScheduledMessage[] {
    return this[scheduledMessagePersistenceContext].runtime.state.scheduledMessages ?? []
  }

  /** The service is the only caller, so last write wins is safe here in a way it
   *  is not for a renderer-supplied whole array. */
  putScheduledMessage(message: ScheduledMessage): void {
    const { runtime, scheduling } = this[scheduledMessagePersistenceContext]
    const existing = runtime.state.scheduledMessages ?? []
    const index = existing.findIndex((entry) => entry.id === message.id)
    runtime.state.scheduledMessages =
      index === -1
        ? [...existing, message]
        : [...existing.slice(0, index), message, ...existing.slice(index + 1)]
    scheduleSave(scheduling)
  }

  deleteScheduledMessage(messageId: string): void {
    const { runtime, scheduling } = this[scheduledMessagePersistenceContext]
    const existing = runtime.state.scheduledMessages ?? []
    const remaining = existing.filter((entry) => entry.id !== messageId)
    if (remaining.length === existing.length) {
      return
    }
    runtime.state.scheduledMessages = remaining
    scheduleSave(scheduling)
  }
}

export function installScheduledMessagePersistenceContext(
  target: ScheduledMessagePersistence,
  source: ScheduledMessagePersistence
): void {
  Object.defineProperty(target, scheduledMessagePersistenceContext, {
    value: source[scheduledMessagePersistenceContext]
  })
}
