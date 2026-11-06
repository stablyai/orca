import { expect } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  queuedImageReaderSnapshot,
  queuedImageSourceIds
} from './agent-session-queued-image-reader'

export async function subscribeQueuedHistory(
  host: StructuredAgentSessionHost,
  journal: AgentSessionJournal,
  params: { sessionId: string; id: string }
) {
  const frames: AgentSessionSubscribeEvent[] = []
  const close = await host.subscribe({
    ...params,
    cursor: journal.cursor(),
    readsCurrentRequests: true,
    boundedFrames: true,
    readHistorySnapshot: queuedImageReaderSnapshot,
    readQueueSourceIds: queuedImageSourceIds,
    emit: (event) => frames.push(event)
  })
  frames.length = 0
  const expectCaughtUp = (
    cursor: ReturnType<AgentSessionJournal['cursor']>,
    archived: (id: string) => boolean
  ) => {
    const batches = frames.filter((event) => event.type === 'batch')
    expect(batches.at(-1)?.batch.cursor).toEqual(cursor)
    expect(
      batches
        .flatMap((event) => event.batch.submissions)
        .some((send) => archived(send.clientMessageId))
    ).toBe(false)
  }
  return { frames, close, expectCaughtUp }
}
