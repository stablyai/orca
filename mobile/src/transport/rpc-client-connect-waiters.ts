export type ConnectWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

export function rejectConnectWaiters(waiters: ConnectWaiter[], reason: string): void {
  const error = new Error(reason)
  for (const waiter of waiters.splice(0)) {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout)
    }
    waiter.reject(error)
  }
}

export function waitForConnectedState(args: {
  state: string
  intentionallyClosed: boolean
  reconnectAttempt: number
  giveUpAfterAttempts: number
  waiters: ConnectWaiter[]
  timeoutMs?: number
}): Promise<void> {
  if (args.state === 'connected') {
    return Promise.resolve()
  }
  if (args.intentionallyClosed) {
    return Promise.reject(new Error('Client closed'))
  }
  if (args.state === 'reconnecting' && args.reconnectAttempt >= args.giveUpAfterAttempts) {
    // Why: past the retry cap the loop only trickles every 90s — callers
    // must fail fast rather than hang on a host that's been unreachable
    // for minutes. A trickle dial that succeeds flips state to 'connected'
    // and later requests go through normally.
    return Promise.reject(new Error('Connection retry limit reached'))
  }
  return new Promise((resolve, reject) => {
    const waiter: ConnectWaiter = { resolve, reject, timeout: null }
    if (args.timeoutMs !== undefined) {
      // Why: explicit per-request timeouts must include offline/reconnect
      // waiting, not only the RPC after the socket becomes connected.
      waiter.timeout = setTimeout(
        () => {
          const index = args.waiters.indexOf(waiter)
          if (index !== -1) {
            args.waiters.splice(index, 1)
          }
          reject(new Error('Timed out while connecting to the remote Orca runtime.'))
        },
        Math.max(0, args.timeoutMs)
      )
    }
    args.waiters.push(waiter)
  })
}
