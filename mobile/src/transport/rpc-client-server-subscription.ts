export function buildReadyStreamUnsubscribe(
  method: string,
  subscriptionId: string
): { method: string; params: { subscriptionId: string } } | null {
  if (method === 'browser.screencast') {
    return { method: 'browser.screencast.unsubscribe', params: { subscriptionId } }
  }
  if (method === 'runtime.clientEvents.subscribe') {
    return { method: 'runtime.clientEvents.unsubscribe', params: { subscriptionId } }
  }
  return null
}
