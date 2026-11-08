import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { FakeFrame } from '../process/testing/acp-scripted-agent.test-support'
import {
  openAcpAdapterRig,
  sendHello,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'
import type { FakeAcpChild } from '../process/testing/acp-scripted-connection.test-fixture'
import { framesOf } from './testing/acp-structured-host.test-support'

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

function watchClose(child: FakeAcpChild, turn: { ended: boolean }) {
  const atClose: { cancels: number | null; turnEnded: boolean | null } = {
    cancels: null,
    turnEnded: null
  }
  const close = child.close.bind(child)
  child.close = async (error?: Error) => {
    atClose.cancels ??= framesOf(child, 'session/cancel').length
    atClose.turnEnded ??= turn.ended
    return close(error)
  }
  return atClose
}

/** Release the provider's held turn end only after the close is observed waiting. */
function answerCancel(child: FakeAcpChild, prompt: FakeFrame, turn: { ended: boolean }) {
  return () => {
    turn.ended = true
    child.agent.reply(prompt, { stopReason: 'cancelled' })
  }
}

async function runningPrompt(rig: AcpAdapterRig): Promise<FakeFrame> {
  await rig.acquire()
  await sendHello(rig, 'send-1')
  return rig.frame('session/prompt')
}

describe('ACP teardown of a running turn', () => {
  it('a close cancels the turn first and ends the child once the agent ends it', async () => {
    const rig = await openAcpAdapterRig()
    const prompt = await runningPrompt(rig)
    const turn = { ended: false }
    const releaseCancel = answerCancel(rig.child(), prompt, turn)
    const atClose = watchClose(rig.child(), turn)
    const closing = rig.adapter.closeSession(SESSION)
    await rig.frame('session/cancel')
    expect(rig.child().closes).toBe(0)
    expect(turn.ended).toBe(false)
    releaseCancel()
    await expect(closing).resolves.toBe(true)
    expect(atClose).toEqual({ cancels: 1, turnEnded: true })
    expect(rig.ended).toMatchObject([{ type: 'ended', cause: 'requested-close' }])
  })

  it('a quit cancels the running turn before ending its child at the grace', async () => {
    const rig = await openAcpAdapterRig({ deps: { stopGraceMs: 20 } })
    await runningPrompt(rig)
    const atClose = watchClose(rig.child(), { ended: false })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const closing = rig.adapter.closeAll()
    await vi.advanceTimersByTimeAsync(19)
    expect(rig.child().closes).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await closing
    expect(atClose).toEqual({ cancels: 1, turnEnded: false })
    expect(rig.child().closes).toBe(1)
  })

  it('a close after a Stop asks no second cancel and waits only what is left of its grace', async () => {
    const rig = await openAcpAdapterRig({ deps: { stopGraceMs: 60_000 } })
    await runningPrompt(rig)
    const child = rig.child()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    await vi.advanceTimersByTimeAsync(20_000)
    const closing = rig.adapter.closeSession(SESSION)
    await vi.advanceTimersByTimeAsync(40_000 - 1)
    expect(child.closes).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await expect(closing).resolves.toBe(true)
    expect(framesOf(child, 'session/cancel')).toHaveLength(1)
  })
})
