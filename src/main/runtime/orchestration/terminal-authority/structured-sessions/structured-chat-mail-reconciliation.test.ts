import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { formatOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { JournalSqlOwner } from '../../../../native-chat/agent-session-journal/journal-sql-owner'
import { JournalSqlReaderPool } from '../../../../native-chat/agent-session-journal/journal-sql-reader-pool'
import { journalSqlReads } from '../../../../native-chat/agent-session-journal/journal-sql-reads'
import { resultOf } from '../../../rpc/orchestration-session-caller-test-fixture'
import { operationId } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  finishWorker,
  host,
  openChat,
  observationClock,
  queuedCardTexts,
  restartRuntime,
  dispatcher,
  request,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

async function busyChat(sessionId: string) {
  const chat = await openChat(sessionId)
  expect(await sendUserMessage(sessionId, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  chat.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
  await host.flushStreamedEvents(sessionId)
  return chat
}

function readsOf(sessionId: string) {
  return journalSqlReads(host.deps.journalDatabase.readers, sessionId)
}

function holdMailRead(sessionId: string, hold: () => Promise<void>): void {
  const read = JournalSqlReaderPool.prototype.point
  let held = false
  vi.spyOn(JournalSqlReaderPool.prototype, 'point').mockImplementation(async function (
    this: JournalSqlReaderPool,
    request
  ) {
    const answer = await read.call(this, request)
    if (!held && request.sessionId === sessionId && request.operation.kind === 'mail-observation') {
      held = true
      await hold()
    }
    return answer
  })
}

describe('mail checks reconcile the currently owned source attempts', () => {
  it('keeps accepted whole direct mail consumed when its live lease renews during the source read', async ({
    onTestFinished
  }) => {
    await openChat(COORDINATOR)
    const chat = await openChat(PEER_CHAT)
    await coordinatorRunAndTask()
    const accepted = Promise.withResolvers<void>()
    const releaseAutomatic = Promise.withResolvers<void>()
    const observed = Promise.withResolvers<void>()
    const releaseCheck = Promise.withResolvers<void>()
    onTestFinished(() => {
      releaseAutomatic.resolve()
      releaseCheck.resolve()
    })
    const observe = host.mailObservation
    let held = false
    vi.spyOn(host, 'mailObservation').mockImplementation(async (...args) => {
      const answer = await observe(...args)
      if (!held && answer.state.kind === 'accepted') {
        held = true
        accepted.resolve()
        await releaseAutomatic.promise
      }
      return answer
    })
    await call(
      'orchestration.send',
      {
        to: formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT)),
        subject: 'already accepted',
        body: 'the complete mail'
      },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    await settleTurn(PEER_CHAT, 0)
    await accepted.promise
    holdMailRead(PEER_CHAT, async () => {
      observed.resolve()
      await releaseCheck.promise
    })
    const checking = call('orchestration.check', {}, { sessionId: PEER_CHAT })
    try {
      await observed.promise
      const before = host.deps.store.getConversation(PEER_CHAT)!
      const now = (before.ownerObservation.lastRenewedAt ?? 0) + 1
      await host.deps.store.renewLease({
        sessionId: PEER_CHAT,
        fence: before.currentFence,
        now,
        childProbe: { outcome: 'identity-matched', matchedOn: ['held-child'] }
      })
      expect(host.deps.store.getConversation(PEER_CHAT)!.ownerObservation.lastRenewedAt).toBe(now)
      releaseCheck.resolve()
      expect(await checking).toMatchObject({ count: 0, messages: [] })
      expect(chat.turns.map(turnText).join('\n')).toContain('the complete mail')
    } finally {
      releaseCheck.resolve()
      releaseAutomatic.resolve()
      await checking
    }
  })

  it('observes the real handoff that sampled owed before the check claimed its mail', async ({
    onTestFinished
  }) => {
    const chat = await busyChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    const sampled = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const claimed = Promise.withResolvers<void>()
    const accepted = Promise.withResolvers<void>()
    onTestFinished(() => {
      release.resolve()
      accepted.resolve()
    })
    const write = JournalSqlOwner.prototype.write
    let held = false
    vi.spyOn(JournalSqlOwner.prototype, 'write').mockImplementation(async function (
      this: JournalSqlOwner,
      command
    ) {
      if (
        !held &&
        command.target.sessionId === COORDINATOR &&
        command.operation.kind === 'automatic-submission' &&
        command.facts?.mail?.some(([, owed]) => owed === 'owed')
      ) {
        held = true
        sampled.resolve()
        await release.promise
      }
      return write.call(this, command)
    })
    const claim = db.getOrCreateMailboxDelivery.bind(db)
    vi.spyOn(db, 'getOrCreateMailboxDelivery').mockImplementation((params) => {
      const result = claim(params)
      if (result) {
        claimed.resolve()
      }
      return result
    })
    const observe = host.mailObservation
    vi.spyOn(host, 'mailObservation').mockImplementation(async (...args) => {
      await accepted.promise
      return observe(...args)
    })
    await settleTurn(COORDINATOR, 0)
    await sampled.promise
    const checking = call('orchestration.check', {}, { sessionId: COORDINATOR })
    await claimed.promise
    try {
      release.resolve()
      await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
      await settleTurn(COORDINATOR, 1)
      accepted.resolve()
      expect(await checking).toMatchObject({ count: 0, messages: [] })
      expect(chat.turns.map(turnText).join('\n')).toContain('(worker_done)')
    } finally {
      release.resolve()
      accepted.resolve()
      await checking
    }
  })

  it('takes direct mail reserved before its host preparation, making the later send obsolete', async ({
    onTestFinished
  }) => {
    await openChat(COORDINATOR)
    const chat = await openChat(PEER_CHAT)
    await coordinatorRunAndTask()
    const reserved = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const attempted = Promise.withResolvers<void>()
    onTestFinished(() => release.resolve())
    const finished = Promise.withResolvers<void>()
    const send = host.send
    vi.spyOn(host, 'send').mockImplementation(async (...args) => {
      if (args[1].envelope.sessionId !== PEER_CHAT) {
        return send(...args)
      }
      reserved.resolve()
      await release.promise
      try {
        const pending = send(...args)
        attempted.resolve()
        return await pending
      } finally {
        finished.resolve()
      }
    })
    await call(
      'orchestration.send',
      {
        to: formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT)),
        subject: 'before preparation',
        body: 'the whole payload'
      },
      { sessionId: COORDINATOR }
    )
    await reserved.promise
    const hold = host.holdMailSources
    let sourceWitness: Promise<void> | undefined
    vi.spyOn(host, 'holdMailSources').mockImplementationOnce(async (...args) => {
      const held = await hold(...args)
      // Compete before final take, while the check still owns the actual source positions.
      release.resolve()
      await attempted.promise
      sourceWitness = host.withForkSourceAdmission(PEER_CHAT, async () => {
        expect(
          db.getUnreadMessages(formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT)))
        ).toEqual([])
      })
      return held
    })
    const invocation = request('orchestration.check', {}, { sessionId: PEER_CHAT })
    try {
      const response = await dispatcher.dispatch(invocation)
      expect(response).toMatchObject({
        ok: true,
        result: {
          count: 1,
          messages: [{ subject: 'before preparation', body: 'the whole payload' }],
          mutation: { requestId: invocation.orchestrationRequestId, replayed: false }
        }
      })
      expect(await dispatcher.dispatch(invocation)).toEqual({
        ...response,
        result: {
          ...resultOf(response),
          mutation: { requestId: invocation.orchestrationRequestId, replayed: true }
        }
      })
    } finally {
      release.resolve()
      await finished.promise
      await sourceWitness
    }
    expect(chat.turns).toEqual([])
  })

  it('re-arbitrates a newly reserved direct source before returning the original selection', async ({
    onTestFinished
  }) => {
    await openChat(COORDINATOR)
    const chat = await busyChat(PEER_CHAT)
    await coordinatorRunAndTask()
    const address = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
    await call(
      'orchestration.send',
      { to: address, subject: 'new reservation', body: 'still the original mail' },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(async () => expect(await queuedCardTexts(PEER_CHAT)).toHaveLength(1), WAIT)
    const original = db.getStructuredMailSends(address)[0]!
    const releaseSettlement = Promise.withResolvers<void>()
    onTestFinished(() => releaseSettlement.resolve())
    const observe = host.mailObservation
    vi.spyOn(host, 'mailObservation').mockImplementation(async (attempt) => {
      if (attempt.operation_id === original.operation_id) {
        await releaseSettlement.promise
      }
      return observe(attempt)
    })
    try {
      const queue = await readsOf(PEER_CHAT).queue({ kind: 'list', facts: { reopenFloor: null } })
      if (queue.kind !== 'list') {
        throw new Error('journal reader returned another queue result')
      }
      const [card] = queue.cards
      const edit = {
        messageId: card!.messageId,
        expectedBodyFingerprint: card!.fingerprint,
        text: 'my edited card'
      }
      expect(
        await host.queuedMessageUpdate(
          { callerKey: 'test-surface' },
          {
            envelope: {
              sessionId: PEER_CHAT,
              clientOperationId: operationId(),
              expectedRuntimeFence: host.deps.store.getConversation(PEER_CHAT)!.currentFence,
              payloadFingerprint: computeAgentSessionPayloadFingerprint({
                method: 'agentSession.queuedMessageUpdate',
                sessionId: PEER_CHAT,
                fields: edit
              })
            },
            ...edit
          }
        )
      ).toMatchObject({ ok: true, value: { status: 'updated' } })
      const fields = { messageId: card!.messageId }
      expect(
        await host.queuedMessageDelete(
          { callerKey: 'test-surface' },
          {
            envelope: {
              sessionId: PEER_CHAT,
              clientOperationId: operationId(),
              expectedRuntimeFence: host.deps.store.getConversation(PEER_CHAT)!.currentFence,
              payloadFingerprint: computeAgentSessionPayloadFingerprint({
                method: 'agentSession.queuedMessageDelete',
                sessionId: PEER_CHAT,
                fields
              })
            },
            ...fields
          }
        )
      ).toMatchObject({ ok: true, value: { deleted: true } })
      expect(await readsOf(PEER_CHAT).mailObservation(original)).toMatchObject({
        withdrawal: 'person'
      })
      const hold = host.holdMailSources
      let replaced = false
      vi.spyOn(host, 'holdMailSources').mockImplementation(async (...args) => {
        const held = await hold(...args)
        if (!replaced) {
          replaced = true
          const [original] = args[0]
          const replacement = {
            ...db.getStructuredMailSend(original!.mailbox_handle, original!.message_id)!,
            operation_id: operationId()
          }
          expect(db.reserveStructuredMailSend(replacement, original!.operation_id)).toBe(true)
        }
        return held
      })
      const invocation = request('orchestration.check', {}, { sessionId: PEER_CHAT })
      const response = await dispatcher.dispatch(invocation)
      expect(response).toMatchObject({
        ok: true,
        result: {
          count: 1,
          messages: [{ subject: 'new reservation', body: 'still the original mail' }],
          mutation: { requestId: invocation.orchestrationRequestId, replayed: false }
        }
      })
      expect(await dispatcher.dispatch(invocation)).toEqual({
        ...response,
        result: {
          ...resultOf(response),
          mutation: { requestId: invocation.orchestrationRequestId, replayed: true }
        }
      })
    } finally {
      releaseSettlement.resolve()
    }
    await settleTurn(PEER_CHAT, 0)
    expect(chat.turns).toHaveLength(1)
  })

  it('recovers unread mail after a system withdrawal wins and its checking caller is fenced', async ({
    onTestFinished
  }) => {
    await busyChat(COORDINATOR)
    const successor = await busyChat(PEER_CHAT)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    const row = db.getStructuredMailSends(`run:${runId}`)[0]!
    const deleting = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const noOp = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    onTestFinished(() => {
      proceed.resolve()
      release.resolve()
    })
    const deleted = host.queuedMessageDelete
    let held = false
    vi.spyOn(host, 'queuedMessageDelete').mockImplementation(async (...args) => {
      if (held) {
        return deleted(...args)
      }
      held = true
      deleting.resolve()
      await proceed.promise
      const answer = await deleted(...args)
      expect(answer).toMatchObject({ ok: true, value: { deleted: false } })
      noOp.resolve()
      try {
        await release.promise
      } finally {
        noOp.resolve()
      }
      return answer
    })
    const checking = dispatcher.dispatch(
      request('orchestration.check', {}, { sessionId: COORDINATOR })
    )
    await deleting.promise
    // D makes the automatic handover stale before check's own delete reaches the writer.
    await settleTurn(COORDINATOR, 0)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toEqual([]), WAIT)
    expect(await host.mailObservation(row)).toMatchObject({
      state: { kind: 'withdrawn' },
      withdrawal: 'system'
    })
    proceed.resolve()
    await noOp.promise
    try {
      await call('orchestration.runUse', { id: runId }, { sessionId: PEER_CHAT })
    } finally {
      release.resolve()
    }
    expect(await checking).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(db.getMessageById(row.message_id)?.read).toBe(0)
    const observation = await host.mailObservation(row)
    expect(observation).toMatchObject({ state: { kind: 'withdrawn' }, withdrawal: 'system' })
    restartRuntime()
    expect(await call('orchestration.check', {}, { sessionId: PEER_CHAT })).toMatchObject({
      runId,
      messages: [{ id: row.message_id, type: 'worker_done', subject: 'Done' }]
    })
    await settleTurn(PEER_CHAT, 0)
    expect(successor.turns).toHaveLength(1)
  })

  it('abandons a disconnected direct read and releases its source position before the reply arrives', async ({
    onTestFinished
  }) => {
    await openChat(COORDINATOR)
    await busyChat(PEER_CHAT)
    await coordinatorRunAndTask()
    const address = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
    await call(
      'orchestration.send',
      { to: address, subject: 'keep after disconnect' },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(async () => expect(await queuedCardTexts(PEER_CHAT)).toHaveLength(1), WAIT)
    const reads = readsOf(PEER_CHAT)
    const epoch = (await reads.cursor()).epoch
    const reading = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    onTestFinished(() => release.resolve())
    const finished = Promise.withResolvers<void>()
    holdMailRead(PEER_CHAT, async () => {
      reading.resolve()
      await release.promise
      finished.resolve()
    })
    const controller = new AbortController()
    const checking = dispatcher.dispatch(
      request('orchestration.check', {}, { sessionId: PEER_CHAT }),
      { signal: controller.signal }
    )
    await reading.promise
    try {
      controller.abort()
      expect(await checking).toMatchObject({ ok: false, error: { code: 'request_aborted' } })
      // This actual source owner runs while the old read reply remains held.
      await host.withForkSourceAdmission(PEER_CHAT, async () => {
        expect((await reads.cursor()).epoch).toBe(epoch)
      })
      expect(db.getUnreadMessages(address)).toMatchObject([{ subject: 'keep after disconnect' }])
    } finally {
      release.resolve()
      await finished.promise
    }
    expect(await call('orchestration.check', {}, { sessionId: PEER_CHAT })).toMatchObject({
      messages: [{ subject: 'keep after disconnect' }]
    })
  })

  it('returns explicit fallback at the invocation deadline and ignores the held late source reply', async ({
    onTestFinished
  }) => {
    await openChat(COORDINATOR)
    await busyChat(PEER_CHAT)
    await coordinatorRunAndTask()
    const address = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
    await call(
      'orchestration.send',
      { to: address, subject: 'deadline fallback' },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(async () => expect(await queuedCardTexts(PEER_CHAT)).toHaveLength(1), WAIT)
    const original = db.getStructuredMailSends(address)[0]!
    const automatic = Promise.withResolvers<void>()
    const observe = host.mailObservation
    vi.spyOn(host, 'mailObservation').mockImplementation(async (...args) => {
      if (args[0].message_id === original.message_id) {
        await automatic.promise
      }
      return observe(...args)
    })
    const reading = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    onTestFinished(() => {
      release.resolve()
      automatic.resolve()
    })
    holdMailRead(PEER_CHAT, async () => {
      reading.resolve()
      await release.promise
      finished.resolve()
    })
    observationClock.start()
    const invocation = request('orchestration.check', {}, { sessionId: PEER_CHAT })
    const checking = dispatcher.dispatch(invocation)
    await reading.promise
    try {
      const replacement = { ...original, operation_id: operationId() }
      expect(db.reserveStructuredMailSend(replacement, original.operation_id)).toBe(true)
      await vi.advanceTimersByTimeAsync(5_000)
      const response = await checking
      expect(response).toMatchObject({
        ok: true,
        result: { count: 1, messages: [{ subject: 'deadline fallback' }] }
      })
      await host.withForkSourceAdmission(PEER_CHAT, async () => {})
      release.resolve()
      await finished.promise
      expect(db.getStructuredMailSend(address, original.message_id)).toEqual(replacement)
      expect(await dispatcher.dispatch(invocation)).toMatchObject({
        ok: true,
        result: { count: 1, messages: [{ subject: 'deadline fallback' }] }
      })
      expect(db.getUnreadMessages(address)).toEqual([])
    } finally {
      release.resolve()
      automatic.resolve()
      await finished.promise
    }
  })
})
