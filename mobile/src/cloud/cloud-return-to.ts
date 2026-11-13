// Where to go once this phone is connected to Orca Cloud: a team link opened before connecting
// (e.g. /cloud/<id>) is returned to after "Connect Orca Cloud" on Home succeeds. Memory only, and
// short-lived: a user who gave up on that link and connects later isn't sent back to it.

const TTL_MS = 10 * 60_000
let returnTo: { path: string; at: number } | null = null

export function setCloudReturnTo(path: string, now: number = Date.now()): void {
  // Only an in-app cloud route (a workspace id, or a team slug and W-number), never anywhere else.
  returnTo = /^\/cloud\/[A-Za-z0-9_-]+(?:\/W-[0-9]+)?$/.test(path) ? { path, at: now } : null
}

export function takeCloudReturnTo(now: number = Date.now()): string | null {
  const entry = returnTo
  returnTo = null
  return entry && now - entry.at <= TTL_MS ? entry.path : null
}
