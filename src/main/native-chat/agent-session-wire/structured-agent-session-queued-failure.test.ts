import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { createClaudeJournalTranslator } from '../../claude/structured/journal/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { readCodexThreadId } from '../../codex/codex-structured-thread-facts'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
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

  it('re-derives the hold after restart and ignores a late failure on an older turn', async () => {
    const working = await start()
    const first = await queue('survives restart')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    await held(first)
    await rig.restartHostProcess()
    expect(await rig.handoff(first)).toBeUndefined()
    expect(
      rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal.newestTurn()
    ).toMatchObject({
      outcome: 'failure'
    })
    const recovered = await start()
    await openRigTurnFor(rig, recovered, 'completed', 'success')
    await openRigTurnFor(rig, working, 'completed', 'failure')
    expect(await rig.queuePause()).toBeNull()
    await dispatched(first)
  })
})
