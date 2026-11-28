/** Names each accepted pane request: its page applies the request's bot item, or none, once per
 *  intent, and treats any later delivery of the same intent as an echo. */
export const SESSION_PANE_INTENT_PARAM = 'paneIntent'

let paneIntents = 0

export function nextPaneIntent(): string {
  paneIntents += 1
  return `${Date.now().toString(36)}-${paneIntents}`
}

/** A session screen's per-request params: forwarded to its page, never part of its remount identity. */
export const SESSION_REQUEST_PARAMS = [
  'paneKey',
  'botItem',
  'homeDraft',
  SESSION_PANE_INTENT_PARAM
] as const

/** The params that name a session screen: a new pane request updates its page instead of remounting it. */
export function sessionScreenIdentity(
  params: Readonly<Record<string, string>>
): Record<string, string> {
  const requests: readonly string[] = SESSION_REQUEST_PARAMS
  return Object.fromEntries(Object.entries(params).filter(([key]) => !requests.includes(key)))
}
