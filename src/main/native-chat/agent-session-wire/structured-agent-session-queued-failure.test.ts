import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { createClaudeJournalTranslator } from '../../claude/structured/journal/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/structured/journal/codex-structured-journal-translation'
import { readCodexThreadId } from '../../codex/app-server/codex-structured-thread-facts'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { ClaudePluginInputError } from '../../claude/claude-plugin-ui'
import { sendAgentTurn } from '../../runtime/orchestration/send-agent-turn'
import { structuredSessionPointerCallerKey } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'

let rig: QueuedMessageTestRig
const clock = createStructuredSessionObservationClock(() => rig.host, SESSION)
beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  clock.start()
})
afterEach(() => clock.restoreBeforeCleanup(() => rig.dispose()))

async function queue(text: string): Promise<string> {
  const result = await rig.send(text, 'queue-if-active').result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error('expected a queued message')
  }
  return result.value.queued.messageId
}

/** An orchestration message, sent the way the mailbox host sends one. */
function mail(text: string) {
  const id = hostTestOperationId()
  const outcome = sendAgentTurn({
    kind: 'structured-session',
    host: rig.host,
    sessionId: SESSION,
    callerKey: structuredSessionPointerCallerKey(SESSION),
    turn: {
      body: {
        ...hostTestMessage(text),
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: 'run:coordinator',
            dispatchId: null,
            messages: [{ messageId: id, runId: 'coordinator', from: 'term_worker' }]
          }
        }
      },
      delivery: 'queue',
      operationId: id,
      expectedRuntimeFence: 1,
      beforeRun: () => {}
    }
  })
  return { id, outcome }
}

async function start(): Promise<string> {
  const id = await rig.workingSend()
  await openRigTurnFor(rig, id)
  await rig.settleAccepted(id, id)
  return id
}

async function held(...ids: string[]): Promise<void> {
  await clock.observe(250)
  expect(await rig.drafts()).toEqual(ids.map((messageId) => ({ messageId, state: 'waiting' })))
  for (const id of ids) {
    expect(await rig.handoff(id)).toBeUndefined()
  }
  expect(await rig.queuePause()).toEqual({ reason: 'failed' })
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(page).toMatchObject({ ok: true, page: { nextQueuedMessageId: null } })
}

async function dispatched(card: string): Promise<string> {
  await eventually(async () => expect((await rig.handoff(card))?.handedOverAt).toBeDefined())
  return rig.handoffId(card)
}

describe('queued follow-ups after an accepted turn fails', () => {
  it.each(['claude', 'codex'] as const)(
    'holds after recorded real %s failure output',
    async (agent) => {
      const id = await rig.workingSend()
      const sink = rig.providerEvents()
      let cards: [string, string] | undefined
      const queueDuringTurn = async () => {
        await sink.written?.()
        const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
        if (!cards && journal.newestTurn()?.state === 'running') {
          await rig.settleAccepted(id, id)
          cards = [
            await queue('first recorded follow-up'),
            await queue('second recorded follow-up')
          ]
        }
      }
      if (agent === 'claude') {
        const translator = createClaudeJournalTranslator({ sink })
        const capture = await readFile(
          new URL(
            '../../claude/__fixtures__/claude-lifecycle-capture-auth-failed.jsonl',
            import.meta.url
          ),
          'utf8'
        )
        const frame = z.object({ at: z.number(), frame: z.record(z.string(), z.unknown()) })
        for (const line of capture.trim().split('\n')) {
          const value: unknown = JSON.parse(line)
          if (z.looseObject({ kind: z.string() }).parse(value).kind !== 'frame') {
            continue
          }
          const entry = frame.parse(value)
          translator.handle({
            type: 'message',
            sessionId: SESSION,
            observedAt: entry.at,
            message: entry.frame
          })
          await queueDuringTurn()
        }
        translator.dispose()
      } else {
        const capture = await readFile(
          new URL('../../codex/__fixtures__/codex-app-server-turn-endings.jsonl', import.meta.url),
          'utf8'
        )
        const frame = z.object({
          case: z.string(),
          t: z.number(),
          method: z.string(),
          params: z.record(z.string(), z.unknown())
        })
        const frames = capture
          .trim()
          .split('\n')
          .map((line) => frame.parse(JSON.parse(line)))
          .filter((entry) => entry.case === '0.158.0-overloaded-503')
        expect(frames.length).toBeGreaterThan(0)
        const threadId = readCodexThreadId(frames[0]?.params) ?? ''
        const translator = createCodexJournalTranslator({
          sink,
          sessionId: SESSION,
          primaryThreadId: () => threadId
        })
        for (const entry of frames) {
          translator.handle({
            type: 'notification',
            sessionId: SESSION,
            threadId,
            method: entry.method,
            params: entry.params,
            observedAt: entry.t
          })
          await queueDuringTurn()
        }
      }
      await sink.written?.()
      await rig.host.flushStreamedEvents(SESSION)
      if (!cards) {
        throw new Error('capture did not open a turn')
      }
      const [first, second] = cards
      await held(first, second)
      expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
      await dispatched(first)
      expect(await rig.handoff(second)).toBeUndefined()
    }
  )

  it('holds queued cards after a plugin ends the live Claude turn, until explicit resume', async () => {
    const id = await rig.workingSend()
    const sink = rig.providerEvents()
    const translator = createClaudeJournalTranslator({ sink })
    translator.handle({
      type: 'message',
      sessionId: SESSION,
      startsTurn: true,
      message: {
        type: 'user',
        uuid: 'plugin-user',
        session_id: 'claude-session',
        isReplay: true,
        parent_tool_use_id: null,
        message: { role: 'user', content: 'plugin probe' }
      }
    })
    await sink.written?.()
    await rig.settleAccepted(id, id)
    const first = await queue('first plugin follow-up')
    const second = await queue('second plugin follow-up')
    const error = new ClaudePluginInputError('blast-radius')
    translator.handle({
      type: 'ended',
      sessionId: SESSION,
      cause: 'unexpected-exit',
      reason: error.message,
      failure: error.failure
    })
    await sink.written?.()
    await rig.host.flushStreamedEvents(SESSION)
    await held(first, second)
    sink.publish()
    await rig.host.flushStreamedEvents(SESSION)
    await held(first, second)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    const handoff = await dispatched(first)
    expect(await rig.handoff(second)).toBeUndefined()
    await openRigTurnFor(rig, handoff)
    await rig.settleAccepted(handoff, 'first')
    await openRigTurnFor(rig, handoff, 'completed', 'success')
    await dispatched(second)
    translator.dispose()
  })

  it('holds every mid-turn card across repeated wakes, then resumes one turn at a time', async () => {
    const working = await start()
    const first = await queue('first')
    const second = await queue('second')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    await held(first, second)
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(journal.queuedMessages.nextInputCard()).toBeNull()
    rig.providerEvents().publish()
    rig.providerEvents().publish()
    await rig.host.flushStreamedEvents(SESSION)
    await held(first, second)

    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    const handoff = await dispatched(first)
    await openRigTurnFor(rig, handoff)
    await rig.settleAccepted(handoff, 'retried')
    await openRigTurnFor(rig, handoff, 'completed', 'failure')
    await held(second)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await dispatched(second)
  })

  it('lets a fresh send recover; another failure holds and a successful turn releases the cards in order', async () => {
    const working = await start()
    const first = await queue('first')
    const second = await queue('second')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    await held(first, second)

    const retrySend = rig.send('retry', 'queue-if-active')
    expect(await retrySend.result).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    await eventually(async () =>
      expect((await rig.submission(retrySend.id))?.handedOverAt).toBeDefined()
    )
    const retry = retrySend.id
    expect(await rig.queuePause()).toBeNull()
    await openRigTurnFor(rig, retry)
    await rig.settleAccepted(retry, 'retry')
    await openRigTurnFor(rig, retry, 'completed', 'failure')
    await held(first, second)

    const recovered = await start()
    await openRigTurnFor(rig, recovered, 'completed', 'success')
    const handoff = await dispatched(first)
    expect(await rig.handoff(second)).toBeUndefined()
    await openRigTurnFor(rig, handoff)
    await rig.settleAccepted(handoff, 'first')
    await openRigTurnFor(rig, handoff, 'completed', 'success')
    await dispatched(second)
  })

  it('lets explicit Send retry a chosen card without consuming the others', async () => {
    const working = await start()
    const first = await queue('first')
    const second = await queue('chosen')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    await held(first, second)
    expect(await rig.sendNow(second)).toMatchObject({ ok: true })
    const handoff = await dispatched(second)
    expect(await rig.handoff(first)).toBeUndefined()
    await openRigTurnFor(rig, handoff)
    await rig.settleAccepted(handoff, 'chosen')
    await openRigTurnFor(rig, handoff, 'completed', 'failure')
    await held(first)
  })

  it('does not mistake a steer accepted inside the failed turn for recovery', async () => {
    const working = await start()
    const first = await queue('keep waiting')
    const steer = rig.send('steer into the running turn')
    await steer.result
    await rig.settleAccepted(steer.id, 'steered')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    await held(first)
  })

  it('does not let a Resume written while the turn still runs waive its later failure', async () => {
    const working = await start()
    const first = await queue('first')
    const second = await queue('second')
    rig.cancelTurn.mockImplementationOnce(async () => {
      throw new Error('interrupt timed out')
    })
    rig.closeSession.mockImplementationOnce(async () => {
      throw new Error('exit not proven')
    })
    await rig.stop()
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await clock.observe(250)
    expect(await rig.handoff(first)).toBeUndefined()
    await openRigTurnFor(rig, working, 'completed', 'failure')
    await rig.host.flushStreamedEvents(SESSION)
    await held(first, second)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await dispatched(first)
    expect(await rig.handoff(second)).toBeUndefined()
  })

  it('re-derives the hold after restart; a later Resume releases it and late revisions do not re-hold', async () => {
    const working = await start()
    const first = await queue('survives restart')
    const second = await queue('second')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    await held(first, second)
    await rig.restartHostProcess()
    expect(await rig.handoff(first)).toBeUndefined()
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(journal.newestTurn()).toMatchObject({ outcome: 'failure' })
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    const handoff = await dispatched(first)
    const failed = () => journal.queuedMessages.pauses().some((pause) => pause.reason === 'failed')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    expect(failed()).toBe(false)
    await openRigTurnFor(rig, handoff)
    await rig.settleAccepted(handoff, 'first')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    expect(failed()).toBe(false)
    await openRigTurnFor(rig, handoff, 'completed', 'success')
    await dispatched(second)
  })

  it('holds orchestration mail that arrives during the hold until Resume', async () => {
    const working = await start()
    const first = await queue('first')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    await held(first)
    const message = mail('worker finished')
    expect(await message.outcome).toMatchObject({ kind: 'queued' })
    await held(first, message.id)
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    const handoff = await dispatched(first)
    expect(await rig.handoff(message.id)).toBeUndefined()
    await openRigTurnFor(rig, handoff)
    await rig.settleAccepted(handoff, 'first')
    await openRigTurnFor(rig, handoff, 'completed', 'success')
    await dispatched(message.id)
  })

  it("lets held mail's Send deliver it, and a person's fresh send still recovers", async () => {
    const working = await start()
    await openRigTurnFor(rig, working, 'completed', 'failure')
    const message = mail('worker finished')
    expect(await message.outcome).toMatchObject({ kind: 'queued' })
    await held(message.id)
    expect(await rig.sendNow(message.id)).toMatchObject({ ok: true })
    const handoff = await dispatched(message.id)
    await openRigTurnFor(rig, handoff)
    await rig.settleAccepted(handoff, 'mail')
    await openRigTurnFor(rig, handoff, 'completed', 'failure')
    const later = mail('another worker finished')
    expect(await later.outcome).toMatchObject({ kind: 'queued' })
    await held(later.id)

    const retrySend = rig.send('retry', 'queue-if-active')
    expect(await retrySend.result).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    await eventually(async () =>
      expect((await rig.submission(retrySend.id))?.handedOverAt).toBeDefined()
    )
    await openRigTurnFor(rig, retrySend.id)
    await rig.settleAccepted(retrySend.id, 'retry')
    await openRigTurnFor(rig, retrySend.id, 'completed', 'success')
    await dispatched(later.id)
  })
})
