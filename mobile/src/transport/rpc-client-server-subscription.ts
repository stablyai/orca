export function buildServerSubscriptionUnsubscribe(
  method: string,
  subscriptionId: string
): { method: string; params: { subscriptionId: string } } | null {
  const unsubscribeMethod = {
    'browser.screencast': 'browser.screencast.unsubscribe',
    'accounts.subscribe': 'accounts.unsubscribe',
    'files.watch': 'files.unwatch',
    'runtime.clientEvents.subscribe': 'runtime.clientEvents.unsubscribe'
  }[method]
  return unsubscribeMethod ? { method: unsubscribeMethod, params: { subscriptionId } } : null
}

export function buildReadyStreamUnsubscribe(
  method: string,
  subscriptionId: string
): { method: string; params: { subscriptionId: string } } | null {
  return buildServerSubscriptionUnsubscribe(method, subscriptionId)
}
