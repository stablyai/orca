const PREFIX = 'browser-screencast:'

export function mintBrowserScreencastSubscriptionId(browserPageId: string, nonce: string): string {
  return `${PREFIX}${browserPageId}:${nonce}`
}

export function browserScreencastSubscriptionPageId(subscriptionId: string): string | null {
  const nonceStart = subscriptionId.lastIndexOf(':')
  if (!subscriptionId.startsWith(PREFIX) || nonceStart <= PREFIX.length) {
    return null
  }
  return subscriptionId.slice(PREFIX.length, nonceStart)
}
