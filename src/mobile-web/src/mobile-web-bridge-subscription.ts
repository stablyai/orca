export type MobileWebBridgeSubscription = {
  ready: Promise<void>
  unsubscribe: () => void
}

export type MobileWebTerminalBridgeSubscription = MobileWebBridgeSubscription & {
  streamId: string
}
