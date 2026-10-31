import type { AgentJournalDispatchState } from '../../../src/shared/agent-session-journal-types'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'
import { ok } from './use-mobile-structured-agent-session-queued.test-fixture'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

export const MODEL_OPTIONS: AgentSessionOptionsResult = {
  conversationCommands: ['compact'],
  models: [
    { id: 'opus', label: 'Opus', isDefault: true, efforts: [] },
    { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }
  ],
  current: { model: 'opus' }
}

export function sendResult(dispatchState: AgentJournalDispatchState, reason: string | null = null) {
  return ok({
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: structuredSendResultFixture(dispatchState, reason)
  })
}
