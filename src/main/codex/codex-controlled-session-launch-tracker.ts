export async function trackControlledSessionLaunch<T>(
  launches: Map<string, Promise<unknown>>,
  conversationId: string,
  assertNotDisposing: (conversationId: string) => void,
  start: () => Promise<T>
): Promise<T> {
  assertNotDisposing(conversationId)
  const active = launches.get(conversationId)
  if (active) {
    await active.catch(() => {})
    return trackControlledSessionLaunch(launches, conversationId, assertNotDisposing, start)
  }
  const launch = start()
  launches.set(conversationId, launch)
  try {
    return await launch
  } finally {
    if (launches.get(conversationId) === launch) {
      launches.delete(conversationId)
    }
  }
}
