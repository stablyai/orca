import { vi } from 'vitest'

export type BusEvent = { type: string; data: Record<string, unknown>; created?: number }

type Blocker = { id: string; sessionID: string; [key: string]: unknown }

function toBlocker(value: unknown): Blocker {
  const record = typeof value === 'object' && value !== null ? { ...value } : {}
  const id = 'id' in record ? String(record.id) : ''
  const sessionID = 'sessionID' in record ? String(record.sessionID) : ''
  return { ...record, id, sessionID }
}

/** One pane's TUI: its route, its view of the shared session store, and the shared event bus. */
export function fakeTui(version = '2.0.14') {
  const listeners = new Set<(event: { details: BusEvent }) => void>()
  const sessions = new Map<
    string,
    { id: string; parentID?: string; outcome?: string; time?: { idle: number } }
  >()
  let idleClock = 1
  const running = new Set<string>()
  const permissions = new Map<string, Blocker[]>()
  const forms = new Map<string, Blocker[]>()
  // What the server answers when the TUI re-fetches a permission list (reconnect).
  const serverPermissions = new Map<string, Blocker[]>()
  let permissionFetch: Promise<void> = Promise.resolve()
  // Why: OpenCode keeps storage.memory across plugin hot reloads within one TUI process.
  const memories = new Map<string, unknown>()
  let route: { type: string; sessionID?: string } = { type: 'home' }
  const rootOf = (id: string): string => {
    let current = sessions.get(id)
    while (current?.parentID && sessions.has(current.parentID)) {
      current = sessions.get(current.parentID)
    }
    return current?.id ?? id
  }
  const without = (map: Map<string, Blocker[]>, sessionID: string, id: unknown): void => {
    map.set(
      sessionID,
      (map.get(sessionID) ?? []).filter((item) => item.id !== id)
    )
  }
  const listen = vi.fn((handler: (event: { details: BusEvent }) => void) => {
    listeners.add(handler)
    return () => listeners.delete(handler)
  })
  const ctx = {
    app: { version, channel: 'latest' },
    ui: { router: { current: () => route } },
    storage: {
      memory: (key: string, options: { initial: Record<string, unknown> }) => {
        if (!memories.has(key)) {
          const value = structuredClone(options.initial)
          memories.set(key, [value, (mutate: (draft: typeof value) => void) => mutate(value)])
        }
        return memories.get(key)
      }
    },
    client: {
      session: { get: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID) }
    },
    data: {
      listen,
      session: {
        get: (id: string) => sessions.get(id),
        root: rootOf,
        family: (id: string) =>
          [...sessions.keys()].filter((member) => rootOf(member) === rootOf(id)),
        status: (id: string) => (running.has(id) ? 'running' : 'idle'),
        permission: {
          list: (id: string) => permissions.get(id),
          sync: async (id: string) => {
            await permissionFetch
            permissions.set(id, [...(serverPermissions.get(id) ?? [])])
          }
        },
        form: { list: (id: string) => forms.get(id), sync: async () => {} }
      }
    }
  }
  return {
    ctx,
    listen,
    serverPermissions,
    permissions,
    navigate(sessionID: string) {
      route = { type: 'session', sessionID }
    },
    // The session data stops reporting a run without this TUI seeing its end event.
    loseEnd(sessionID: string) {
      running.delete(sessionID)
    },
    // The session data reports a run whose start this TUI never saw.
    loseStart(sessionID: string) {
      running.add(sessionID)
      const session = sessions.get(sessionID)
      if (session) {
        session.outcome = undefined
      }
    },
    // Holds the next permission list fetch until the returned release is called.
    holdPermissionFetch(): () => void {
      let release = (): void => {}
      permissionFetch = new Promise((resolve) => {
        release = resolve
      })
      return release
    },
    // Ending events reach listeners before the session snapshot catches up.
    emit(event: BusEvent) {
      const sessionID = String(event.data.sessionID)
      let notified = false
      if (event.type === 'session.created') {
        const parentID = typeof event.data.parentID === 'string' ? event.data.parentID : undefined
        sessions.set(sessionID, { id: sessionID, parentID })
      } else if (event.type === 'session.execution.started') {
        running.add(sessionID)
        const session = sessions.get(sessionID)
        if (session) {
          session.outcome = undefined
        }
      } else if (
        event.type === 'session.execution.succeeded' ||
        event.type === 'session.execution.failed' ||
        event.type === 'session.execution.interrupted'
      ) {
        event = { ...event, created: ++idleClock }
        for (const handler of listeners) {
          handler({ details: event })
        }
        notified = true
        running.delete(sessionID)
        const session = sessions.get(sessionID)
        if (session) {
          session.outcome = event.type.slice('session.execution.'.length)
          session.time = { idle: idleClock }
        }
      } else if (event.type === 'permission.asked') {
        permissions.set(sessionID, [...(permissions.get(sessionID) ?? []), toBlocker(event.data)])
      } else if (event.type === 'permission.replied') {
        without(permissions, sessionID, event.data.requestID)
      } else if (event.type === 'form.created') {
        const form = toBlocker(event.data.form)
        forms.set(form.sessionID, [...(forms.get(form.sessionID) ?? []), form])
      } else if (event.type === 'form.replied' || event.type === 'form.cancelled') {
        without(forms, sessionID, event.data.id)
      }
      if (!notified) {
        for (const handler of listeners) {
          handler({ details: event })
        }
      }
    }
  }
}
