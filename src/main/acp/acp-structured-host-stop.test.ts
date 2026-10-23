import { deferred } from './acp-scripted-agent.test-support'
// A Grok chat's Stop through the real host: it ends the process once Grok settles its turn, and the
// next send resumes the session.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { withNativeChatCutTurnNotices } from '../../shared/native-chat-cut-turn-notice'
import {
  closeProviderTimelineRigs,
  providerTurnId
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { PROVIDER_SESSION, replyChunk, waitFor } from './acp-structured-adapter.test-support'
import {
  framesOf,
  openAttachedHostRig,
  promptIdOf,
  send,
  stop
} from './acp-structured-host.test-support'

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

describe('a Grok chat Stop', () => {
  it('ends Grok once it settles the turn, and the next send resumes with no notice', async () => {
    const { rig, host, count, rows, turns, messages } = await openAttachedHostRig()
    const first = rig.child()
    await send(host, 'hello')
    const prompt = await rig.frame('session/prompt')
    first.agent.notify('session/update', replyChunk(promptIdOf(prompt), 'partial'))
    // Grok takes a moment to wind the turn down; the host waits for it before ending the process.
    const answered: { cancel: boolean; atClose: boolean | null } = { cancel: false, atClose: null }
    const cancellation = deferred<void>()
    first.agent.on('session/cancel', () => cancellation.resolve())
    const close = first.close.bind(first)
    first.close = async () => {
      answered.atClose ??= answered.cancel
      return close()
    }
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    try {
      expect(await stop(host)).toMatchObject({ ok: true, value: { cancelled: true } })
      await cancellation.promise
      expect(first.exited).toBe(false)
      expect(answered.atClose).toBeNull()
    } finally {
      answered.cancel = true
      first.agent.reply(prompt, { stopReason: 'cancelled' })
    }
    await waitFor(() => expect(first.exited).toBe(true))
    expect(framesOf(first, 'session/cancel')).toHaveLength(1)
    expect(answered.atClose).toBe(true)
    expect((await turns()).at(-1)).toMatchObject({ state: 'interrupted' })

    await send(host, 'again')
    await waitFor(() => expect(rig.child()).not.toBe(first))
    const second = rig.child()
    const secondPrompt = await rig.frame('session/prompt')
    expect(count.loads).toBe(1)
    expect(framesOf(second, 'session/new')).toHaveLength(0)
    expect(await messages()).toEqual(['hello', 'partial', 'again'])
    // Only the Stop's own note: no exit or cut-reply notice for a Stop the person asked for.
    const transcript = withNativeChatCutTurnNotices(await rows(), { agentName: 'Grok' })
    expect(
      transcript.flatMap((row) => (row.body.kind === 'status' ? [row.body.text] : []))
    ).toEqual(['Cancellation requested.'])
    second.agent.on('session/cancel', () =>
      second.agent.reply(secondPrompt, { stopReason: 'cancelled' })
    )
    await host.close(SESSION, 'user-close')
  })

  it('ends Grok at the grace when Grok never reads the cancel, never waiting on its write', async () => {
    const { rig, host, turns } = await openAttachedHostRig({ stopGraceMs: 30 })
    const first = rig.child()
    await send(host, 'hello')
    const prompt = await rig.frame('session/prompt')
    first.agent.notify('session/update', replyChunk(promptIdOf(prompt), 'partial'))
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    // A write that never completes, as a full pipe to a Grok that stopped reading.
    let cancels = 0
    const deadlineStarted = deferred<void>()
    let deadlineElapsed = false
    const requestEnd = rig.adapter.awaitStoppedRequestEnd
    const waiting = vi
      .spyOn(rig.adapter, 'awaitStoppedRequestEnd')
      .mockImplementation((sessionId, at) => {
        const pending = requestEnd(sessionId, at)
        deadlineStarted.resolve()
        return pending.then(() => {
          deadlineElapsed = true
        })
      })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    first.cancel = () => {
      cancels += 1
      return new Promise(() => {})
    }
    expect(await stop(host)).toMatchObject({ ok: true, value: { cancelled: true } })
    await deadlineStarted.promise
    expect(first.exited).toBe(false)
    await vi.advanceTimersByTimeAsync(29)
    expect(first.exited).toBe(false)
    expect(deadlineElapsed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(deadlineElapsed).toBe(true)
    await waitFor(() => expect(first.exited).toBe(true))
    waiting.mockRestore()
    vi.useRealTimers()
    expect(cancels).toBe(1)
    expect((await turns()).at(-1)).toMatchObject({ state: 'interrupted' })
  })

  it('ends Grok on a Stop of a turn it began itself, once that turn ends', async () => {
    const { rig, host, turns } = await openAttachedHostRig()
    const { agent } = rig.child()
    agent.notify('session/update', replyChunk('task-completed-background-1', 'Working on it'))
    agent.on('session/cancel', () =>
      agent.notify('x.ai/session_notification', {
        sessionId: PROVIDER_SESSION,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'task-completed-background-1',
          stop_reason: 'cancelled'
        }
      })
    )
    await rig.settle()
    expect((await turns()).at(-1)).toMatchObject({ state: 'running' })
    expect(await stop(host)).toMatchObject({ ok: true, value: { cancelled: true } })
    await waitFor(() => expect(rig.child().exited).toBe(true))
    expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(1)
    expect((await turns()).at(-1)).toMatchObject({ state: 'interrupted' })
    await host.close(SESSION, 'user-close')
  })

  it('leaves no Grok behind whose background work could begin a turn after the Stop', async () => {
    const { rig, host, rows, turns } = await openAttachedHostRig()
    const first = rig.child()
    await send(host, 'hello')
    const prompt = await rig.frame('session/prompt')
    first.agent.notify('session/update', replyChunk(promptIdOf(prompt), 'started a build'))
    first.agent.notify('x.ai/task_backgrounded', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'task_backgrounded', task_id: 'build-1', command: 'make all' }
    })
    first.agent.on('session/cancel', () => first.agent.reply(prompt, { stopReason: 'cancelled' }))
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    await stop(host)
    await waitFor(() => expect(first.exited).toBe(true))
    // The task ended with Grok's process; Orca cannot say how, so its row says no more than that.
    const task = (await rows()).find((row) => row.itemId.includes('background-task'))
    expect(task?.body).toMatchObject({
      blocks: [
        { type: 'text', text: 'Background command "make all" stopped reporting' },
        { type: 'background-task', taskId: 'build-1', state: 'unverifiable' }
      ]
    })
    const settled = await turns()
    // What a kept process would do once its backgrounded build finished.
    first.agent.notify('session/update', replyChunk('task-completed-background-1', 'Build done'))
    await rig.settle()
    expect(await turns()).toEqual(settled)
    expect(settled.map((turn) => turn.state)).not.toContain('running')
    await host.close(SESSION, 'user-close')
  })
})

describe('a Grok chat Stop naming a turn that has ended', () => {
  it('stops neither the turn running now nor Grok', async () => {
    const { rig, host, turns } = await openAttachedHostRig()
    const { agent } = rig.child()
    await send(host, 'old')
    const old = await rig.frame('session/prompt')
    agent.notify('session/update', replyChunk(promptIdOf(old), 'done'))
    agent.reply(old, { stopReason: 'end_turn' })
    await rig.settle()
    await send(host, 'new')
    const current = await rig.frame('session/prompt', 1)
    agent.notify('session/update', replyChunk(promptIdOf(current), 'working'))
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    const stopped = await stop(host, providerTurnId(promptIdOf(old), PROVIDER_SESSION))
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
    await rig.settle()
    expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)
    expect(rig.child().exited).toBe(false)
    expect((await turns()).at(-1)).toMatchObject({ state: 'running' })
    agent.on('session/cancel', () => agent.reply(current, { stopReason: 'cancelled' }))
    await host.close(SESSION, 'user-close')
  })

  // A late Stop is an accepted no-op, as a Claude Stop is: the follow-up handed over but not yet
  // echoed is left alone.
  it('leaves Grok and the next prompt alone in the gap before Grok echoes it', async () => {
    const { rig, host, rows, turns } = await openAttachedHostRig()
    const { agent } = rig.child()
    await send(host, 'old')
    const old = await rig.frame('session/prompt')
    agent.notify('session/update', replyChunk(promptIdOf(old), 'done'))
    agent.reply(old, { stopReason: 'end_turn' })
    await rig.settle()
    await send(host, 'new')
    const next = await rig.frame('session/prompt', 1)
    await host.flushStreamedEvents(SESSION)
    const stopped = await stop(host, providerTurnId(promptIdOf(old), PROVIDER_SESSION))
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
    await rig.settle()
    expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)
    expect(rig.child().exited).toBe(false)
    expect((await rows()).filter((row) => row.body.kind === 'status')).toEqual([])
    agent.notify('session/update', replyChunk(promptIdOf(next), 'answered'))
    agent.reply(next, { stopReason: 'end_turn' })
    await rig.settle()
    await waitFor(async () =>
      expect((await turns()).map((turn) => turn.state)).toEqual(['completed', 'completed'])
    )
    await host.close(SESSION, 'user-close')
  })
})
