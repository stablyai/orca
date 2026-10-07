// A message the host accepted while the agent was starting, then Orca quit or crashed, or the chat
// closed, before handing it over: it is kept as a held card at the head of the queue, never sent on
// its own, and released only by the person's own Send, Edit or Delete on it. Against the real host,
// store and journal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { QUEUED_MESSAGE_PAUSED_KEPT } from '../../../shared/agent-session-queued-message-wire'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { createStructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { journalIdentityFor } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

/** Orchestration mail as the mailbox sends it: from another agent, naming its sender. */
const MAIL_SOURCE: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'agent:coordinator', terminalHandle: null, orcaSessionId: null },
      name: null
    }
  ],
  orchestration: { message: 'mail-notice', mailbox: 'agent:worker', dispatchId: null, messages: [] }
}

const HOST_RESTARTED = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
  surface: 'rejection'
})
const CHAT_CLOSED = agentSessionFailureWords(agentSessionFailureFact('chatClosed'), {
  surface: 'rejection'
})
const KEPT = { state: 'waiting', paused: true }

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
})

/** The exact request a client sends, so a test can send the same one again. */
function sendRequest(text: string, delivery?: 'queue-if-active') {
  const body = hostTestMessage(text)
  const fields = { body, ...(delivery ? { delivery } : {}) }
  return {
    envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId()),
    body,
    ...(delivery ? { delivery } : {}),
    userSend: true as const
  }
}

/** Lets the spawn `acceptWhileStarting` holds finish; until then the message stays queued. */
let releaseStart = (): void => {}

/** Accepted while the agent is starting, and never handed over: Orca stops during its spawn. */
async function acceptWhileStarting(
  request: Parameters<QueuedMessageTestRig['host']['send']>[1],
  // Sent with it, so each is accepted before the spawn takes the chat's lane.
  ...alsoQueued: Parameters<QueuedMessageTestRig['host']['send']>[1][]
): Promise<string> {
  // No child, so this send must start one.
  await rig.host.close(SESSION, 'evict')
  const startsBefore = rig.starts.mock.calls.length
  releaseStart = rig.holdNextStart()
  const sent = await Promise.all(
    [request, ...alsoQueued].map((each) => rig.host.send(QUEUED_RIG_CALLER, each))
  )
  for (const result of sent) {
    expect(result).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending', handoverRecorded: true } }
    })
  }
  await eventually(() => expect(rig.starts.mock.calls.length).toBeGreaterThan(startsBefore))
  return request.envelope.clientOperationId
}

/** Closes the chat while its spawn is held: the close takes the lane once the spawn returns. */
async function closeWhileStarting(cause: 'user-close' | 'evict'): Promise<void> {
  const closed = rig.host.close(SESSION, cause)
  releaseStart()
  releaseStart = () => {}
  await closed
}

/** The app quits: delivery stops first, so the held spawn finishing hands nothing over. */
async function quitRestart(): Promise<void> {
  const quit = rig.quitRestartHostProcess()
  releaseStart()
  releaseStart = () => {}
  await quit
}

function journal(): AgentSessionJournal {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('the conversation is not open')
  }
  return open
}

function dispatchedTexts(): string[] {
  return rig.dispatch.mock.calls.map(([input]) =>
    input.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
  )
}

describe('a message accepted while the agent starts, then Orca stops', () => {
  it.each([
    { how: 'quit', restart: () => quitRestart() },
    { how: 'crash', restart: async () => rig.crashRestartHostProcess() }
  ])('is a held card after a $how, and its submission is rejected unseen', async ({ restart }) => {
    const id = await acceptWhileStarting(sendRequest('hello after restart'))
    await restart()

    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    // Held on its own: no queue-wide pause, so no Resume to press.
    expect(await rig.queuePause()).toBeNull()
    expect(await rig.submission(id)).toMatchObject({
      dispatchState: 'rejected',
      ...HOST_RESTARTED,
      origin: 'client',
      source: { kind: 'user' }
    })
    const [card] = journal().queuedMessages.list()
    expect(card).toMatchObject({
      messageId: id,
      holdReason: QUEUED_MESSAGE_PAUSED_KEPT,
      hostInstance: structuredAgentSessionHostInstance(),
      body: hostTestMessage('hello after restart'),
      queuedAt: { epoch: journal().epoch, sequence: expect.any(Number) }
    })
    // Nothing is sent on its own, however many times the chat reopens.
    await rig.host.close(SESSION, 'evict')
    rig.crashRestartHostProcess()
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    expect(rig.dispatch).not.toHaveBeenCalled()
  })

  it('quit writes nothing for it: no closed-chat rejection, still queued until the next open', async () => {
    const id = await acceptWhileStarting(sendRequest('kept through quit'))
    await quitRestart()
    // Read beside the host, without opening the chat through it: the row the quit left.
    const leftover = await peekSubmission(id)
    expect(leftover).toMatchObject({ dispatchState: 'pending', handoverRecorded: true })
    expect(leftover?.handedOverAt).toBeUndefined()
  })

  it('keeps several in the order they were accepted, ahead of the cards already queued', async () => {
    const second = sendRequest('second')
    const first = await acceptWhileStarting(sendRequest('first'), second)
    await rig.crashRestartHostProcess()

    expect(await rig.drafts()).toEqual([
      { messageId: first, ...KEPT },
      { messageId: second.envelope.clientOperationId, ...KEPT }
    ])
  })
})

describe('only an action on the card releases a kept card', () => {
  it('a later message is delivered alone; Resume sends nothing; its own Send sends it once', async () => {
    const id = await acceptWhileStarting(sendRequest('the kept words'))
    await quitRestart()

    // The person types the same words again, as one who cannot see cards would.
    const retyped = rig.send('the kept words')
    await retyped.result
    await eventually(async () =>
      expect((await rig.submission(retyped.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(retyped.id, 'retyped')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(dispatchedTexts()).toEqual(['the kept words'])
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])

    await rig.resume()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await rig.handoff(id)).toBeUndefined()
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])

    expect(await rig.sendNow(id)).toMatchObject({ ok: true })
    const handoff = await rig.handoff(id)
    expect(handoff?.clientMessageId).not.toBe(id)
    expect(handoff).toMatchObject({ origin: 'client' })
    await eventually(() => expect(dispatchedTexts()).toEqual(['the kept words', 'the kept words']))
    expect(await rig.drafts()).toEqual([])
  })

  it('Send now sends it at once, and Delete removes it', async () => {
    const deleted = sendRequest('delete me')
    const sent = await acceptWhileStarting(sendRequest('send me now'), deleted)
    await quitRestart()

    expect(await rig.deleteQueued(deleted.envelope.clientOperationId)).toMatchObject({
      ok: true,
      value: { deleted: true }
    })
    expect(await rig.sendNow(sent)).toMatchObject({
      ok: true,
      value: { submission: { queuedMessageId: sent, origin: 'client' } }
    })
    await eventually(() => expect(dispatchedTexts()).toEqual(['send me now']))
    expect(await rig.drafts()).toEqual([])
  })

  // Edit is the card's text in the composer, the card's Delete, then a new send. Neither leaves
  // anything of the original send, even beside the sending desktop's own copy of it.
  it.each(['Edit', 'Delete'] as const)('%s leaves no trace of the kept send', async (action) => {
    const request = sendRequest('the kept words')
    const id = await acceptWhileStarting(request)
    await quitRestart()
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    expect(await rig.deleteQueued(id)).toMatchObject({ ok: true, value: { deleted: true } })
    const edited = action === 'Edit' ? rig.send('the edited words') : null
    if (edited) {
      await edited.result
      await eventually(async () =>
        expect((await rig.submission(edited.id))?.handedOverAt).toBeDefined()
      )
      await rig.settleAccepted(edited.id, 'edited')
    }

    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history refused')
    }
    const lingering = {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: id,
        sessionId: SESSION,
        text: 'the kept words',
        attachments: [],
        queuedAt: 1
      }),
      state: 'rejected' as const
    }
    const shown = projectStructuredAgentSessionMessages(
      page.page.items,
      [lingering],
      page.page.submissions,
      // The desktop's transcript, which draws a rejected send in place unless it was kept.
      { rejectedInPlace: true }
    ).map((message) => ({
      text: message.blocks.map((block) => ('text' in block ? block.text : '')).join(''),
      unsent: message.unsent ?? false
    }))
    expect(shown).toEqual(action === 'Edit' ? [{ text: 'the edited words', unsent: false }] : [])
    expect(await rig.drafts()).toEqual([])
  })

  it('a Stop on the reopened chat leaves it kept: the open settles it before the Stop runs', async () => {
    const id = await acceptWhileStarting(sendRequest('survives a stop'))
    await rig.crashRestartHostProcess()

    expect(await rig.stop()).toMatchObject({ ok: true })

    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    expect(await rig.submission(id)).toMatchObject({ dispatchState: 'rejected', ...HOST_RESTARTED })
  })

  // A Send now cut short by a quit hands the card back kept, so a retyped copy still goes alone.
  // After a second restart the kept card is another process's, yet it pauses nothing else.
  it('a later restart leaves the cards queued after it unpaused', async () => {
    const id = await acceptWhileStarting(sendRequest('kept twice over'))
    await quitRestart()
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    rig.crashRestartHostProcess()
    const working = await rig.workingSend()
    const later = rig.send('queued after the restart', 'queue-if-active')
    expect(await later.result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })

    expect(await rig.queuePause()).toBeNull()
    await rig.settleAccepted(working, 'working')
    await eventually(() =>
      expect(dispatchedTexts()).toEqual(['work on this', 'queued after the restart'])
    )
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
  })

  it('stays kept when its own Send is cut short by another quit', async () => {
    const id = await acceptWhileStarting(sendRequest('the kept words'))
    await quitRestart()
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    // A /compact runs, so the Send now waits behind it, and Orca quits before it is handed over.
    const fields = { command: 'compact' as const }
    expect(
      await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    expect(await rig.sendNow(id)).toMatchObject({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await rig.handoff(id))?.handedOverAt).toBeUndefined()
    await quitRestart()

    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    expect(journal().queuedMessages.get(id)?.holdReason).toBe(QUEUED_MESSAGE_PAUSED_KEPT)
    const retyped = rig.send('the kept words')
    await retyped.result
    await eventually(async () =>
      expect((await rig.submission(retyped.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(retyped.id, 'retyped')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(dispatchedTexts()).toEqual(['the kept words'])
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
  })
})

// The queue stops with delivery at quit, so a quit makes no hand-off only the next process could
// settle: the queued cards come back as a crash leaves them, under the restart's hold.
describe('cards queued behind a working turn, then Orca stops', () => {
  it.each(['quit', 'crash'] as const)(
    'after a %s they wait under the restart hold, not kept, with no hand-off made',
    async (how) => {
      await rig.workingSend()
      const first = rig.send('queued behind work', 'queue-if-active')
      expect(await first.result).toMatchObject({
        ok: true,
        value: { queued: { state: 'waiting' } }
      })
      const second = rig.send('second queued behind work', 'queue-if-active')
      expect(await second.result).toMatchObject({
        ok: true,
        value: { queued: { state: 'waiting' } }
      })
      if (how === 'quit') {
        await quitRestart()
      } else {
        rig.crashRestartHostProcess()
      }

      expect(await rig.drafts()).toEqual([
        { messageId: first.id, state: 'waiting' },
        { messageId: second.id, state: 'waiting' }
      ])
      // The restart's hold is never published; the cards still wait.
      expect(await rig.queuePause()).toBeNull()
      expect(await rig.handoff(first.id)).toBeUndefined()
      expect(journal().queuedMessages.get(first.id)?.holdReason).toBeNull()
    }
  )
})

describe('the queue at a quit', () => {
  /** A /compact the provider took; its end, written later by `finishCompact`, wakes the drain. */
  async function compactRunning(): Promise<void> {
    const fields = { command: 'compact' as const }
    expect(
      await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
  }

  // Quit's first step is `stopDelivery`, before teardown drains recovery; the flush repeats it.
  it.each(['stopDelivery', 'flushAllStreamedEvents'] as const)(
    'a drain step already running when quit begins (%s) makes no hand-off',
    async (quitStep) => {
      await compactRunning()
      const queued = rig.send('queued behind the compact', 'queue-if-active')
      expect(await queued.result).toMatchObject({
        ok: true,
        value: { queued: { state: 'waiting' } }
      })
      const host = rig.host
      const { queuedMessages } = journal()
      const settleOwed = queuedMessages.settleOwed.bind(queuedMessages)
      let release = (): void => undefined
      const held = new Promise<void>((resolve) => (release = resolve))
      let reached = (): void => undefined
      const inStep = new Promise<void>((resolve) => (reached = resolve))
      let blocked = false
      // Holds the drain step at its one await, past its first dispose check, until quit has begun.
      // Only the drain step heals owed bookkeeping, so no caller check is needed (nor a stack read,
      // which runtimes format differently).
      const owed = vi.spyOn(queuedMessages, 'settlementOwed').mockImplementation(() => !blocked)
      const healing = vi.spyOn(queuedMessages, 'settleOwed').mockImplementation(async () => {
        if (!blocked) {
          blocked = true
          reached()
          await held
        }
        return settleOwed()
      })
      rig.finishCompact()
      await inStep
      if (quitStep === 'stopDelivery') {
        host.stopDelivery()
        release()
        await healing.mock.results[0]?.value
        // The step's append check runs on the turn after its heal resolves.
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(await rig.handoff(queued.id)).toBeUndefined()
      } else {
        const quitting = host.flushAllStreamedEvents()
        release()
        await quitting
      }
      owed.mockRestore()
      healing.mockRestore()
      rig.crashRestartHostProcess()

      expect(await rig.drafts()).toEqual([{ messageId: queued.id, state: 'waiting' }])
      expect(await rig.queuePause()).toBeNull()
      expect(await rig.handoff(queued.id)).toBeUndefined()
      expect(rig.dispatch).not.toHaveBeenCalled()
    }
  )

  // The card the person pushed ahead waits for their own Send; Resume sends the rest.
  it('Send now on an ordinary card, cut short by a quit, returns it kept while Resume sends the rest', async () => {
    await compactRunning()
    const first = rig.send('first queued', 'queue-if-active')
    await first.result
    const pushed = rig.send('pushed ahead', 'queue-if-active')
    await pushed.result
    expect(await rig.sendNow(pushed.id)).toMatchObject({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await rig.handoff(pushed.id))?.handedOverAt).toBeUndefined()
    await quitRestart()

    expect(await rig.drafts()).toEqual([
      { messageId: pushed.id, ...KEPT },
      { messageId: first.id, state: 'waiting' }
    ])
    expect(await rig.queuePause()).toBeNull()
    await rig.resume()
    await eventually(() => expect(dispatchedTexts()).toEqual(['first queued']))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await rig.drafts()).toEqual([{ messageId: pushed.id, ...KEPT }])
  })
})

// The same rule as a restart: tab close, worktree teardown and an orchestration stop all close the
// chat, and the chat can be reopened from its history.
describe('a message accepted while the agent starts, then the chat closes', () => {
  it.each(['user-close', 'evict'] as const)(
    'after a %s it is a held card the reopened chat shows, rejected as closed',
    async (cause) => {
      const id = await acceptWhileStarting(sendRequest('kept at close'))
      await closeWhileStarting(cause)
      rig.crashRestartHostProcess()

      expect(await rig.submission(id)).toMatchObject({ dispatchState: 'rejected', ...CHAT_CLOSED })
      expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
      const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
      if (!page.ok) {
        throw new Error('history refused')
      }
      // The desktop drops its own copy at tab close; the card is what shows the words.
      const texts = projectStructuredAgentSessionMessages(
        page.page.items,
        [],
        page.page.submissions,
        { rejectedInPlace: true }
      )
        .flatMap((shown) => shown.blocks.map((block) => ('text' in block ? block.text : '')))
        .join('|')
      expect(texts).not.toContain('kept at close')
      expect(page.page.queuedMessages?.[0]).toMatchObject({
        body: hostTestMessage('kept at close'),
        pausedReason: QUEUED_MESSAGE_PAUSED_KEPT
      })
      expect(rig.dispatch).not.toHaveBeenCalled()
    }
  )
})

// The desktop's outbox keeps an unconfirmed send and sends it again, under the same id, once the
// app is back. That replay meets the card the open made from the same send.
describe('the same send arriving again after the restart', () => {
  it('a client that never asked to queue is answered from its own record: one card, still held, nothing sent', async () => {
    const request = sendRequest('sent again by the outbox')
    const id = await acceptWhileStarting(request)
    await quitRestart()
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    const submissionsBefore = (await rig.host.journalSnapshot(SESSION)).submissions.length

    const again = await rig.host.send(QUEUED_RIG_CALLER, request)

    // Never the queued arm, which only a client that sent `delivery` can read; the card it sees
    // under the same id is what tells it the host holds the message.
    expect(again).toMatchObject({
      ok: true,
      replayed: true,
      value: { clientMessageId: id, submission: { dispatchState: 'rejected', ...HOST_RESTARTED } }
    })
    expect(again.ok && 'queued' in again.value).toBe(false)
    expect((await rig.host.journalSnapshot(SESSION)).submissions).toHaveLength(submissionsBefore)
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rig.dispatch).not.toHaveBeenCalled()

    // Retry on such a client sends the words under a new id: delivered once, the card still held.
    const retried = rig.send('sent again by the outbox')
    await retried.result
    await eventually(async () =>
      expect((await rig.submission(retried.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(retried.id, 'retried')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(dispatchedTexts()).toEqual(['sent again by the outbox'])
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
  })

  it('a client that asked to queue is told the host holds it', async () => {
    const request = sendRequest('queued-capable resend', 'queue-if-active')
    const id = await acceptWhileStarting(request)
    await rig.crashRestartHostProcess()

    expect(await rig.host.send(QUEUED_RIG_CALLER, request)).toMatchObject({
      ok: true,
      value: { clientMessageId: id, queued: { messageId: id, state: 'waiting' } }
    })
    expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }])
    expect(rig.dispatch).not.toHaveBeenCalled()
  })
})

describe('what is not kept', () => {
  // Mail names its sender on its body (an agent); a dispatch preamble names none. Neither is a
  // person's, and the submission's kind is read off that.
  it.each([
    { by: 'mail', from: MAIL_SOURCE, recorded: { kind: 'agent' } },
    { by: 'dispatch', from: undefined, recorded: undefined }
  ])('an orchestration $by send is rejected, as before', async ({ by, from, recorded }) => {
    const { userSend: _person, ...sent } = sendRequest(by)
    await acceptWhileStarting({ ...sent, ...(from ? { body: { ...sent.body, from } } : {}) })
    await rig.crashRestartHostProcess()
    expect(await rig.drafts()).toEqual([])
    const submission = await rig.submission(sent.envelope.clientOperationId)
    expect(submission).toMatchObject({ dispatchState: 'rejected', ...HOST_RESTARTED })
    expect(submission?.source).toEqual(recorded)
  })

  // Not a client's send, but the person's: the host sends a launch's first prompt for them.
  it("keeps a launch's first prompt, which the host sends for the person", async () => {
    const { userSend: _client, ...sent } = sendRequest('the launch prompt')
    await acceptWhileStarting({ ...sent, personsMessage: true })
    await rig.crashRestartHostProcess()
    expect(await rig.drafts()).toEqual([{ messageId: sent.envelope.clientOperationId, ...KEPT }])
    expect(await rig.submission(sent.envelope.clientOperationId)).toMatchObject({
      origin: 'host',
      source: { kind: 'user' }
    })
  })

  it('a send whose card could not be written is rejected as before, and nothing stays queued', async () => {
    const id = await acceptWhileStarting(sendRequest('card write fails'))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(JournalQueuedMessages.prototype, 'holdInTransaction').mockImplementation(() => {
      throw new Error('disk full')
    })
    rig.crashRestartHostProcess()

    await eventually(async () =>
      expect(await rig.submission(id)).toMatchObject({
        dispatchState: 'rejected',
        ...HOST_RESTARTED
      })
    )
    expect(await rig.drafts()).toEqual([])
    // No card holds it, so its rejection names none.
    expect(await rig.submission(id)).not.toHaveProperty('keptAsQueuedMessageId')
    expect(warned).toHaveBeenCalledWith(
      '[journal-hold] keeping an unsent send failed:',
      expect.objectContaining({ clientMessageId: id, cause: 'hostRestarted' })
    )
  })

  it('the delivery step keeps one the open could not settle, and hands nothing over', async () => {
    const id = await acceptWhileStarting(sendRequest('open write failed'))
    const resolve = AgentSessionJournal.prototype.resolveDispatch
    // The open's keep and its plain-rejection fallback both fail.
    let failures = 2
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(AgentSessionJournal.prototype, 'resolveDispatch').mockImplementation(function (
      this: AgentSessionJournal,
      ...args: Parameters<AgentSessionJournal['resolveDispatch']>
    ) {
      if (failures > 0 && args[0].clientMessageId === id) {
        failures -= 1
        return Promise.reject(new Error('disk busy'))
      }
      return resolve.apply(this, args)
    })
    await quitRestart()
    // The open's write failed; a new send wakes the delivery loop, whose first step settles it.
    const next = rig.send('wakes the loop')
    await next.result
    await eventually(async () => expect(await rig.drafts()).toEqual([{ messageId: id, ...KEPT }]))
    await eventually(() => expect(dispatchedTexts()).toEqual(['wakes the loop']))
    expect(await rig.submission(id)).toMatchObject({ dispatchState: 'rejected', ...HOST_RESTARTED })
  })
})

describe('/clear carries a kept card still held', () => {
  it('a turn in the new conversation never releases it', async () => {
    const id = await acceptWhileStarting(sendRequest('carried through clear'))
    await quitRestart()
    expect(await rig.drafts()).toHaveLength(1)
    const fields = { command: 'clear' as const }
    const cleared = await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    expect(await rig.drafts(replacementId)).toEqual([{ messageId: id, ...KEPT }])
    const carried = rig.host.collaboratorsForTests().sessions.get(replacementId)?.journal
    expect(carried?.queuedMessages.list()[0]?.holdReason).toBe(QUEUED_MESSAGE_PAUSED_KEPT)

    const body = hostTestMessage('first turn after the clear')
    const turn = await rig.host.send(QUEUED_RIG_CALLER, {
      envelope: {
        sessionId: replacementId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: replacementId,
          fields: { body }
        })
      },
      body,
      userSend: true
    })
    const turnId = turn.ok ? turn.value.clientMessageId : ''
    await eventually(async () =>
      expect(
        (await rig.host.journalSnapshot(replacementId)).submissions.find(
          (entry) => entry.clientMessageId === turnId
        )?.handedOverAt
      ).toBeDefined()
    )
    await rig.host.settleLateDispatch({
      sessionId: replacementId,
      clientMessageId: turnId,
      providerIdentity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-x', ordinal: 0 }
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await rig.drafts(replacementId)).toEqual([{ messageId: id, ...KEPT }])
    expect(dispatchedTexts()).toEqual(['first turn after the clear'])
  })
})

/** The submission as the quit left it, read from a journal opened beside the host's. */
async function peekSubmission(id: string) {
  const record = rig.store.getRecord(SESSION)!
  const params = attachParamsForRecord(record, {
    clientOperationId: 'peek',
    expectedRuntimeFence: record.lease.runtimeFence
  })
  const peeked = await openAgentSessionJournal({
    identity: journalIdentityFor(record, params),
    database: openTestJournalHostDatabase(rig.root)
  })
  try {
    return peeked.submission(id)
  } finally {
    await peeked.close()
  }
}
