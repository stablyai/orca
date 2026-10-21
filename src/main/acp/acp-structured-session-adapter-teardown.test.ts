// A close, dispose or quit while a turn runs: the agent is asked to cancel it and given the Stop's
// grace to end it before its process goes, as a Stop does; an idle close goes at once.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { tick, type FakeFrame } from './acp-scripted-agent.test-support'
import {
  openAcpAdapterRig,
  sendHello,
  type AcpAdapterRig,
  type FakeAcpChild
} from './acp-structured-adapter.test-support'
import { framesOf, openAttachedHostRig, send } from './acp-structured-host.test-support'
import { ACP_STOP_GRACE_MS } from './acp-structured-session-adapter-deps'

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

/** What Orca had written, and whether the turn had ended, when it first asked the child to close. */
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

/** The agent ends the cancelled turn a moment after Orca asks. */
function answerCancel(child: FakeAcpChild, prompt: FakeFrame, turn: { ended: boolean }) {
  child.agent.on('session/cancel', () =>
    setTimeout(() => {
      turn.ended = true
      child.agent.reply(prompt, { stopReason: 'cancelled' })
    }, 30)
  )
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
    answerCancel(rig.child(), prompt, turn)
    const atClose = watchClose(rig.child(), turn)
    await expect(rig.adapter.closeSession(SESSION)).resolves.toBe(true)
    expect(atClose).toEqual({ cancels: 1, turnEnded: true })
    expect(rig.ended).toMatchObject([{ type: 'ended', cause: 'requested-close' }])
  })

  it('a dispose ends the child at the grace when the agent never ends its turn', async () => {
    const rig = await openAcpAdapterRig()
    await runningPrompt(rig)
    const child = rig.child()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const closing = rig.adapter.disposeSession(SESSION)
    await vi.advanceTimersByTimeAsync(ACP_STOP_GRACE_MS - 1)
    await tick()
    expect(framesOf(child, 'session/cancel')).toHaveLength(1)
    expect(child.closes).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await expect(closing).resolves.toBe(true)
    expect(child.closes).toBe(1)
  })

  it('a quit cancels every running turn before it ends the children, within the grace', async () => {
    const rig = await openAcpAdapterRig({ deps: { stopGraceMs: 20 } })
    await runningPrompt(rig)
    const atClose = watchClose(rig.child(), { ended: false })
    await rig.adapter.closeAll()
    expect(atClose).toEqual({ cancels: 1, turnEnded: false })
    expect(rig.child().closes).toBe(1)
  })

  it('a close still ends the child when the cancel cannot be written', async () => {
    const rig = await openAcpAdapterRig({ deps: { stopGraceMs: 20 } })
    await runningPrompt(rig)
    const cancel = vi.spyOn(rig.child(), 'cancel').mockRejectedValue(new Error('EPIPE'))
    await expect(rig.adapter.closeSession(SESSION)).resolves.toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
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

describe('ACP teardown with nothing to cancel', () => {
  it('an idle close writes no cancel and ends the child at once', async () => {
    const rig = await openAcpAdapterRig({ deps: { stopGraceMs: 60_000 } })
    await rig.acquire()
    await expect(rig.adapter.closeSession(SESSION)).resolves.toBe(true)
    expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)
    expect(rig.child().closes).toBe(1)
  })

  it('a close after the connection broke writes no cancel and waits for nothing', async () => {
    const rig = await openAcpAdapterRig({ deps: { stopGraceMs: 60_000 } })
    await runningPrompt(rig)
    const child = rig.child()
    const cancel = vi.spyOn(child, 'cancel')
    let proves = false
    child.proveClose = async () => {
      if (proves) {
        child.exit()
      }
      return proves
    }
    child.agent.stdin.destroy()
    await vi.waitFor(() => expect(child.closes).toBe(1))
    proves = true
    await expect(rig.adapter.closeSession(SESSION)).resolves.toBe(true)
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('a Grok chat closed through the host while its turn runs', () => {
  it('cancels the turn before ending the process, and the turn ends interrupted', async () => {
    const { rig, host, turns } = await openAttachedHostRig()
    const child = rig.child()
    await send(host, 'hello')
    const prompt = await rig.frame('session/prompt')
    const turn = { ended: false }
    answerCancel(child, prompt, turn)
    const atClose = watchClose(child, turn)
    await host.close(HOST_TEST_SESSION, 'user-close')
    expect(atClose).toEqual({ cancels: 1, turnEnded: true })
    expect(child.exited).toBe(true)
    expect((await turns()).at(-1)).toMatchObject({ state: 'interrupted' })
  })
})
