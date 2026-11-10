import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { useMobileStructuredStopOffer } from './use-mobile-structured-stop-offer'

describe('useMobileStructuredStopOffer', () => {
  let renderer: ReactTestRenderer | null = null
  let offer: { canStop: boolean; sending: () => boolean; send: () => Promise<string> } | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function harness(send: () => Promise<string>, stopsConversation: boolean, sessionKey: string) {
    function Harness(): null {
      const { canStop, sendsOut } = useMobileStructuredStopOffer({
        sessionKey,
        turnId: null,
        isWorking: false,
        stopsConversation
      })
      offer = { canStop, sending: sendsOut.sending, send: sendsOut.trackSend(send) }
      return null
    }
    return createElement(Harness)
  }

  it.each([true, false])(
    'offers Stop for a send in flight only where the host stops the conversation (%s)',
    async (stopsConversation) => {
      let settle!: (value: string) => void
      const send = () => new Promise<string>((resolve) => (settle = resolve))
      act(() => {
        renderer = create(harness(send, stopsConversation, 'chat'))
      })
      expect(offer?.canStop).toBe(false)

      let sent: Promise<string> | undefined
      act(() => {
        sent = offer?.send()
      })
      expect(offer?.canStop).toBe(stopsConversation)
      expect(offer?.sending()).toBe(true)

      await act(async () => {
        settle('accepted')
        await sent
      })
      expect(offer?.canStop).toBe(false)
      expect(offer?.sending()).toBe(false)
    }
  )

  it("keeps one chat's send out of another chat's Stop and command hold", () => {
    const send = () => new Promise<string>(() => {})
    act(() => {
      renderer = create(harness(send, true, 'first'))
    })
    act(() => {
      void offer?.send()
    })
    expect(offer?.sending()).toBe(true)

    act(() => renderer?.update(harness(send, true, 'second')))
    expect(offer?.canStop).toBe(false)
    expect(offer?.sending()).toBe(false)
  })
})
