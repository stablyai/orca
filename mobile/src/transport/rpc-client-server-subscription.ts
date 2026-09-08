export function buildServerSubscriptionUnsubscribe(
  method: string,
  subscriptionId: string,
  cleanupMethod?: string
): { method: string; params: { subscriptionId: string } } | null {
  const unsubscribeMethod =
    cleanupMethod ??
    {
      'browser.screencast': 'browser.screencast.unsubscribe',
      'accounts.subscribe': 'accounts.unsubscribe',
      'files.watch': 'files.unwatch',
      'runtime.clientEvents.subscribe': 'runtime.clientEvents.unsubscribe'
    }[method]
  return unsubscribeMethod ? { method: unsubscribeMethod, params: { subscriptionId } } : null
}
