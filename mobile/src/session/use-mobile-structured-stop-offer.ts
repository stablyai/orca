import { useCallback, useMemo, useRef, useState } from 'react'
import { structuredAgentSessionCanStop } from '../../../src/shared/structured-agent-session-stop-control'

type Send<Args extends unknown[], Result> = (...args: Args) => Promise<Result>

export type MobileStructuredSendsOut = {
  trackSend: <Args extends unknown[], Result>(send: Send<Args, Result>) => Send<Args, Result>
  sending: () => boolean
}

/** Desktop's Stop rule, counting this chat's message sends still awaiting the host as sending. */
export function useMobileStructuredStopOffer(input: {
  sessionKey: string
  turnId: string | null
  isWorking: boolean
  stopsConversation: boolean
}): { canStop: boolean; sendsOut: MobileStructuredSendsOut } {
  const { sessionKey } = input
  const countsRef = useRef(new Map<string, number>())
  // Re-render only when a chat starts or stops having a send out, not on every send.
  const [sendingKeys, setSendingKeys] = useState<ReadonlySet<string>>(() => new Set())
  const trackSend = useCallback(
    <Args extends unknown[], Result>(send: Send<Args, Result>): Send<Args, Result> =>
      async (...args) => {
        const count = (by: 1 | -1) => {
          const next = (countsRef.current.get(sessionKey) ?? 0) + by
          if (next === 0) {
            countsRef.current.delete(sessionKey)
          } else {
            countsRef.current.set(sessionKey, next)
          }
          if (next === 0 || (next === 1 && by === 1)) {
            setSendingKeys((previous) => {
              const keys = new Set(previous)
              if (next === 0) {
                keys.delete(sessionKey)
              } else {
                keys.add(sessionKey)
              }
              return keys
            })
          }
        }
        count(1)
        try {
          return await send(...args)
        } finally {
          count(-1)
        }
      },
    [sessionKey]
  )
  const sendsOut = useMemo(
    () => ({ trackSend, sending: () => countsRef.current.has(sessionKey) }),
    [sessionKey, trackSend]
  )
  return {
    canStop: structuredAgentSessionCanStop({
      turnId: input.turnId,
      isWorking: input.isWorking,
      sending: sendingKeys.has(sessionKey),
      stopsConversation: input.stopsConversation
    }),
    sendsOut
  }
}
