import type { WebContents } from 'electron'

// Why: Orca attaches its own CDP sessions to a guest's cross-site frames to deliver agent input
// there (see guest-focused-frame-route.ts). This file owns those sessions: one per frame target,
// adopted even when the attach answers late, and hidden from the agent's CDP client.

export type GuestSessionCdpSender = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
) => Promise<unknown>

// Why: a page paused in a debugger or blocked on a dialog never answers; input must not wait on it.
const PAGE_PROBE_TIMEOUT_MS = 500
// Why: the target list changes only when frames come and go; one lookup serves a burst of keys.
const TARGET_LIST_TTL_MS = 1_000

type FrameSessions = {
  sessionIdByTargetId: Map<string, string>
  ownedSessionIds: Set<string>
  emulatedSessionIds: Set<string>
  attachByTargetId: Map<string, Promise<string | null>>
  crossSiteTargets: { ids: Set<string>; at: number } | null
}

const frameSessionsByGuest = new WeakMap<WebContents, FrameSessions>()

function frameSessionsFor(webContents: WebContents): FrameSessions {
  let sessions = frameSessionsByGuest.get(webContents)
  if (!sessions) {
    sessions = {
      sessionIdByTargetId: new Map(),
      ownedSessionIds: new Set(),
      emulatedSessionIds: new Set(),
      attachByTargetId: new Map(),
      crossSiteTargets: null
    }
    frameSessionsByGuest.set(webContents, sessions)
  }
  return sessions
}

export function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || !(key in value)) {
    return null
  }
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value
  return field !== null && typeof field === 'object' && !Array.isArray(field)
    ? Object.fromEntries(Object.entries(field))
    : null
}

export function readString(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key]
  return typeof field === 'string' ? field : null
}

export type Settled<T> = { outcome: 'ok'; value: T } | { outcome: 'failed' | 'timeout' }

/** Settles a page request within the probe timeout, telling a rejection from a slow page. */
export async function settle<T>(request: Promise<T>): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request.then(
        (value): Settled<T> => ({ outcome: 'ok', value }),
        (): Settled<T> => ({ outcome: 'failed' })
      ),
      new Promise<Settled<T>>((resolve) => {
        timer = setTimeout(() => resolve({ outcome: 'timeout' }), PAGE_PROBE_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves to `fallback` when the page rejects or does not answer within the probe timeout. */
export async function settleWithin<T>(request: Promise<T>, fallback: T): Promise<T> {
  const settled = await settle(request)
  return settled.outcome === 'ok' ? settled.value : fallback
}

/**
 * True for debugger traffic that belongs to Orca's own frame sessions; the CDP proxy keeps it
 * from the agent's client, which never asked for those sessions.
 */
export function isOrcaFrameSessionTraffic(
  webContents: WebContents,
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | undefined
): boolean {
  const sessions = frameSessionsByGuest.get(webContents)
  if (!sessions) {
    return false
  }
  if (sessionId && sessions.ownedSessionIds.has(sessionId)) {
    return true
  }
  if (method !== 'Target.attachedToTarget' && method !== 'Target.detachedFromTarget') {
    return false
  }
  const eventSessionId = readString(params ?? null, 'sessionId')
  const targetId = readString(readRecord(params, 'targetInfo'), 'targetId')
  const owned = eventSessionId !== null && sessions.ownedSessionIds.has(eventSessionId)
  if (method === 'Target.detachedFromTarget' && eventSessionId) {
    forgetFrameSession(webContents, eventSessionId)
    sessions.ownedSessionIds.delete(eventSessionId)
  }
  // Why: Chromium reports Orca's attach before answering it, while the attach is still in flight.
  return owned || (targetId !== null && sessions.attachByTargetId.has(targetId))
}

export function forgetFrameSession(webContents: WebContents, sessionId: string): void {
  const sessions = frameSessionsFor(webContents)
  sessions.emulatedSessionIds.delete(sessionId)
  for (const [targetId, cached] of sessions.sessionIdByTargetId) {
    if (cached === sessionId) {
      sessions.sessionIdByTargetId.delete(targetId)
    }
  }
}

/** Orca's session on a frame target; concurrent callers share one attach, and a late one is kept. */
export async function frameSessionFor(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  targetId: string
): Promise<string | null> {
  const sessions = frameSessionsFor(webContents)
  const cached = sessions.sessionIdByTargetId.get(targetId)
  if (cached) {
    return cached
  }
  let attach = sessions.attachByTargetId.get(targetId)
  if (!attach) {
    attach = send('Target.attachToTarget', { targetId, flatten: true })
      .then((attached) => {
        const sessionId = readString(
          attached !== null && typeof attached === 'object'
            ? Object.fromEntries(Object.entries(attached))
            : null,
          'sessionId'
        )
        if (sessionId) {
          // Why: owned even if this caller gave up waiting, so its events stay hidden.
          sessions.ownedSessionIds.add(sessionId)
          sessions.sessionIdByTargetId.set(targetId, sessionId)
        }
        return sessionId
      })
      .catch(() => null)
      .finally(() => sessions.attachByTargetId.delete(targetId))
    sessions.attachByTargetId.set(targetId, attach)
  }
  return await settleWithin(attach, null)
}

/** Cross-site frame target ids, from a briefly cached target list. */
export async function crossSiteFrameTargets(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  { refresh }: { refresh: boolean }
): Promise<Set<string>> {
  const sessions = frameSessionsFor(webContents)
  const cached = sessions.crossSiteTargets
  if (!refresh && cached && Date.now() - cached.at < TARGET_LIST_TTL_MS) {
    return cached.ids
  }
  const response = await settleWithin(send('Target.getTargets', {}), null)
  const infos =
    response !== null && typeof response === 'object' && 'targetInfos' in response
      ? Object.getOwnPropertyDescriptor(response, 'targetInfos')?.value
      : null
  const ids = new Set<string>()
  if (Array.isArray(infos)) {
    for (const info of infos) {
      if (info !== null && typeof info === 'object') {
        const record = Object.fromEntries(Object.entries(info))
        const targetId = readString(record, 'targetId')
        if (record.type === 'iframe' && targetId) {
          ids.add(targetId)
        }
      }
    }
  }
  sessions.crossSiteTargets = { ids, at: Date.now() }
  return ids
}

/** Sends input on a frame session with focus emulation on, enabled once per session. */
export async function sendFrameSessionInput(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  sessionId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const sessions = frameSessionsFor(webContents)
  if (!sessions.emulatedSessionIds.has(sessionId)) {
    // Why: editors that check document.hasFocus() need it. Retried once and recorded only on
    // success; input is sent either way, as a frame failing twice is navigating and loses it anyway.
    const enable = (): Promise<boolean> =>
      send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).then(
        () => true,
        () => false
      )
    if ((await enable()) || (await enable())) {
      sessions.emulatedSessionIds.add(sessionId)
    }
  }
  return await send(method, params, sessionId)
}
