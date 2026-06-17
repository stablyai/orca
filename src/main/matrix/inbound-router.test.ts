import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboundMatrixMessage } from './types'

const sendToRoom = vi.fn(async () => ({ ok: true as const, eventId: '$reply' }))
const sendReaction = vi.fn(async () => ({ ok: true as const, eventId: '$react' }))
const paneKeyForHandle = vi.fn<(handle: string) => string | null>()
const paneKeyForOutboundEvent = vi.fn<(eventId: string) => string | null>()
const hasPendingAsk = vi.fn<(paneKey: string) => boolean>()
const resolveAsk = vi.fn<(paneKey: string, answer: string) => boolean>()

vi.mock('./matrix-service', () => ({
  getMatrixService: () => ({ sendToRoom, sendReaction, onInbound: vi.fn() })
}))
vi.mock('./session-handle-registry', () => ({
  paneKeyForHandle: (handle: string) => paneKeyForHandle(handle)
}))
vi.mock('./outbound-message-session-registry', () => ({
  paneKeyForOutboundEvent: (eventId: string) => paneKeyForOutboundEvent(eventId)
}))
vi.mock('./operator-ask-registry', () => ({
  hasPendingAsk: (paneKey: string) => hasPendingAsk(paneKey),
  resolveAsk: (paneKey: string, answer: string) => resolveAsk(paneKey, answer)
}))

import { routeInbound, type RuntimeDelivery } from './inbound-router'

function inbound(body: string, inReplyToEventId?: string): InboundMatrixMessage {
  return {
    eventId: '$evt',
    roomId: '!room',
    sender: '@user:hs',
    body,
    ts: 0,
    ...(inReplyToEventId ? { inReplyToEventId } : {})
  }
}

function makeRuntime(overrides: Partial<RuntimeDelivery> = {}): RuntimeDelivery {
  return {
    getAgentStatusTerminalHandleForPaneKey: vi.fn(() => 'term-1'),
    sendTerminal: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('routeInbound', () => {
  beforeEach(() => {
    sendToRoom.mockClear()
    sendReaction.mockClear()
    paneKeyForHandle.mockReset()
    paneKeyForOutboundEvent.mockReset()
    // Default: the replied-to event is not a known outbound message, so the
    // @handle path is exercised unless a test opts into the reply path.
    paneKeyForOutboundEvent.mockReturnValue(null)
    hasPendingAsk.mockReset()
    hasPendingAsk.mockReturnValue(false)
    resolveAsk.mockReset()
    resolveAsk.mockReturnValue(true)
  })

  it('ignores unaddressed messages', async () => {
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('just chatting in the room'))
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(sendToRoom).not.toHaveBeenCalled()
  })

  it('replies loudly when the handle is unknown', async () => {
    paneKeyForHandle.mockReturnValue(null)
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('@ghost do the thing'))
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(sendToRoom).toHaveBeenCalledWith(expect.stringContaining('not a known Orca session'), {
      inReplyTo: '$evt'
    })
  })

  it('replies loudly when the session is no longer active', async () => {
    paneKeyForHandle.mockReturnValue('tab:leaf')
    const runtime = makeRuntime({ getAgentStatusTerminalHandleForPaneKey: vi.fn(() => undefined) })
    await routeInbound(runtime, inbound('@a3f9 hello'))
    expect(sendToRoom).toHaveBeenCalledWith(expect.stringContaining('no longer an active'), {
      inReplyTo: '$evt'
    })
  })

  it('delivers the message body (without the handle) to the live session', async () => {
    paneKeyForHandle.mockReturnValue('tab:leaf')
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('@a3f9 run the tests'))
    expect(runtime.sendTerminal).toHaveBeenCalledWith('term-1', {
      text: 'run the tests',
      enter: true
    })
    expect(sendToRoom).not.toHaveBeenCalled()
    // Receipt acknowledgement: a reaction on the operator's message.
    expect(sendReaction).toHaveBeenCalledWith('$evt', '✅')
  })

  it('does not deliver an empty body', async () => {
    paneKeyForHandle.mockReturnValue('tab:leaf')
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('@a3f9    '))
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('routes the reply to a pending ask instead of the terminal', async () => {
    paneKeyForHandle.mockReturnValue('tab:leaf')
    hasPendingAsk.mockReturnValue(true)
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('@a3f9 yes, proceed'))
    expect(resolveAsk).toHaveBeenCalledWith('tab:leaf', 'yes, proceed')
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(sendToRoom).not.toHaveBeenCalled()
  })

  it('keeps a pending ask waiting on an empty reply', async () => {
    paneKeyForHandle.mockReturnValue('tab:leaf')
    hasPendingAsk.mockReturnValue(true)
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('@a3f9    '))
    expect(resolveAsk).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('falls through to terminal delivery when no ask is pending', async () => {
    paneKeyForHandle.mockReturnValue('tab:leaf')
    hasPendingAsk.mockReturnValue(false)
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('@a3f9 run the tests'))
    expect(resolveAsk).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).toHaveBeenCalledWith('term-1', {
      text: 'run the tests',
      enter: true
    })
  })

  it('replies loudly when delivery throws', async () => {
    paneKeyForHandle.mockReturnValue('tab:leaf')
    const runtime = makeRuntime({
      sendTerminal: vi.fn(async () => {
        throw new Error('terminal_not_writable')
      })
    })
    await routeInbound(runtime, inbound('@a3f9 hello'))
    expect(sendToRoom).toHaveBeenCalledWith(expect.stringContaining('Failed to deliver'), {
      inReplyTo: '$evt'
    })
  })

  it('routes a reply to a known outbound event to its session, no @handle needed', async () => {
    paneKeyForOutboundEvent.mockReturnValue('tab:leaf')
    const runtime = makeRuntime()
    await routeInbound(
      runtime,
      inbound('> <@user:hs> [orca a3f9] working\n\nrun the tests', '$out')
    )
    expect(paneKeyForOutboundEvent).toHaveBeenCalledWith('$out')
    // @handle lookup must NOT be consulted — the reply relation wins.
    expect(paneKeyForHandle).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).toHaveBeenCalledWith('term-1', {
      text: 'run the tests',
      enter: true
    })
  })

  it('strips the rich-reply fallback before delivering a reply', async () => {
    paneKeyForOutboundEvent.mockReturnValue('tab:leaf')
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('> <@user:hs> question\n\nyes do it', '$out'))
    expect(runtime.sendTerminal).toHaveBeenCalledWith('term-1', {
      text: 'yes do it',
      enter: true
    })
  })

  it('falls back to @handle parsing when the reply is to an unknown event', async () => {
    paneKeyForOutboundEvent.mockReturnValue(null)
    paneKeyForHandle.mockReturnValue('tab:leaf')
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('@a3f9 run the tests', '$unknown'))
    expect(paneKeyForHandle).toHaveBeenCalledWith('a3f9')
    expect(runtime.sendTerminal).toHaveBeenCalledWith('term-1', {
      text: 'run the tests',
      enter: true
    })
  })

  it("resolves a pending ask when replying to that session's message", async () => {
    paneKeyForOutboundEvent.mockReturnValue('tab:leaf')
    hasPendingAsk.mockReturnValue(true)
    const runtime = makeRuntime()
    await routeInbound(runtime, inbound('> <@user:hs> proceed?\n\nyes, proceed', '$out'))
    expect(resolveAsk).toHaveBeenCalledWith('tab:leaf', 'yes, proceed')
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(sendToRoom).not.toHaveBeenCalled()
  })

  it('replies loudly when replying to a session that has since closed', async () => {
    paneKeyForOutboundEvent.mockReturnValue('tab:leaf')
    const runtime = makeRuntime({ getAgentStatusTerminalHandleForPaneKey: vi.fn(() => undefined) })
    await routeInbound(runtime, inbound('> <@user:hs> q\n\nhello again', '$out'))
    expect(sendToRoom).toHaveBeenCalledWith(expect.stringContaining('no longer an active'), {
      inReplyTo: '$evt'
    })
  })
})
