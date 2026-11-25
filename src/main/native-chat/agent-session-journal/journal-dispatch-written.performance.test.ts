import { expect, it, vi } from 'vitest'
import { StructuredAgentSessionConversations } from '../agent-session-wire/host/structured-agent-session-conversations'
import { hostTestAttachParams } from '../agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { openJournal, receipt } from './journal-dispatch-written.test-fixture'

it('keeps a receipt commit off the host publication and reader paths', async () => {
  const journal = await openJournal()
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'Check the job' }]
  }
  await journal.appendSubmission({
    clientMessageId: 'send',
    payloadFingerprint: 'send',
    body,
    fence: 2,
    handoverRecorded: true,
    origin: 'client'
  })
  const { handoverCursor } = await journal.prepareHandover({
    clientMessageId: 'send',
    body,
    fence: 2,
    turnScope: { kind: 'thread' }
  })
  let now = 100
  const observe = vi.fn()
  const deliver = vi.fn()
  const workChanged = vi.fn()
  const generationObserver = vi.fn()
  const sessions = new StructuredAgentSessionConversations({
    observe,
    deliver,
    workChanged,
    logger: { warn: () => {}, error: () => {} },
    now: () => now
  })
  sessions.set('session', { journal, params: hostTestAttachParams(null), child: null })
  const release = sessions.observeConversationPublications('session', {
    next: generationObserver,
    error: (error) => {
      throw error
    }
  })
  observe.mockClear()
  workChanged.mockClear()
  generationObserver.mockClear()
  const cursor = journal.cursor()
  try {
    now = 500
    await journal.markDispatchWritten({
      clientMessageId: 'send',
      handoverCursor: handoverCursor!,
      fence: 2,
      observedAt: now,
      providerReceipt: true
    })
    expect(await receipt('send')).toBe(500)
    expect(sessions.lastActivityAt('session')).toBe(500)
    expect(journal.cursor()).toEqual(cursor)
    expect(observe).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(workChanged).not.toHaveBeenCalled()
    expect(generationObserver).not.toHaveBeenCalled()
  } finally {
    release()
    sessions.clear()
  }
})
