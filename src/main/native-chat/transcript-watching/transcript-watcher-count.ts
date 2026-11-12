let activeWatcherCount = 0

export const getActiveNativeChatWatcherCount = (): number => activeWatcherCount
export const trackActiveNativeChatWatcher = (delta: 1 | -1): void =>
  void (activeWatcherCount += delta)
