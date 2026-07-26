import { mobileTerminalRetryDelay } from './mobile-terminal-retry-delay'

export function recoverMobileTerminalSubscription(args: {
  handle: string
  attempt?: number
  unsubscribe: (handle: string) => void
  subscribe: (handle: string, attempt: number) => void
  isCurrent: (handle: string) => boolean
  schedule: (action: () => void, delayMs: number) => void
}): void {
  args.unsubscribe(args.handle)
  const attempt = Math.max(0, args.attempt ?? 0)
  args.schedule(() => {
    if (args.isCurrent(args.handle)) {
      args.subscribe(args.handle, attempt + 1)
    }
  }, mobileTerminalRetryDelay(attempt))
}
