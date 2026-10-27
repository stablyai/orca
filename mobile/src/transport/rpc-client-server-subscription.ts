// Streams whose host names its registration only in the `ready` frame. The transport that saw that
// frame is the only holder of a current id, so it alone sends the release.
export const READY_STREAM_RELEASE_METHODS: ReadonlyMap<string, string> = new Map([
  ['browser.screencast', 'browser.screencast.unsubscribe'],
  ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe'],
  ['notifications.subscribe', 'notifications.unsubscribe'],
  ['accounts.subscribe', 'accounts.unsubscribe']
])

export function isReadyIdStream(method: string | undefined): boolean {
  return method !== undefined && READY_STREAM_RELEASE_METHODS.has(method)
}

export function buildReadyStreamUnsubscribe(
  method: string,
  subscriptionId: string
): { method: string; params: { subscriptionId: string } } | null {
  const release = READY_STREAM_RELEASE_METHODS.get(method)
  return release ? { method: release, params: { subscriptionId } } : null
}
