import type { WebContents } from 'electron'

// Orca owns these frame-input sessions; hide their traffic from the agent's CDP client.

export type GuestSessionCdpSender = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
) => Promise<unknown>

// Paused pages and dialogs must not block input routing indefinitely.
const PAGE_PROBE_TIMEOUT_MS = 500
// Reuse target discovery across bursts of keystrokes.
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

export async function settleWithin<T>(request: Promise<T>, fallback: T): Promise<T> {
  const settled = await settle(request)
  return settled.outcome === 'ok' ? settled.value : fallback
}

/** Hide Orca-owned session traffic that the agent's client did not request. */
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
  // Chromium emits attachedToTarget before answering the pending attach.
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

/** Share concurrent attaches and retain sessions that answer after the caller times out. */
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
          // Late sessions remain owned so their events stay hidden.
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

export async function sendFrameSessionInput(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  sessionId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const sessions = frameSessionsFor(webContents)
  if (!sessions.emulatedSessionIds.has(sessionId)) {
    // Editors need document.hasFocus(); cache successful emulation but keep input best effort.
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
