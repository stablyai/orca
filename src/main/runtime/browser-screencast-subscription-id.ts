const PREFIX = 'browser-screencast:'

export function mintBrowserScreencastSubscriptionId(browserPageId: string, nonce: string): string {
  return `${PREFIX}${browserPageId}:${nonce}`
}

/** The page a screencast subscription id was minted for, or null when it is not one. */
export function browserScreencastSubscriptionPageId(subscriptionId: string): string | null {
  const nonceStart = subscriptionId.lastIndexOf(':')
  if (!subscriptionId.startsWith(PREFIX) || nonceStart <= PREFIX.length) {
    return null
  }
  return subscriptionId.slice(PREFIX.length, nonceStart)
}
