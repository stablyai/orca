import { vi } from 'vitest'
import { fakeTui } from './opencode-tui-session-fixture'

export type LegacyTuiEvent = { type: string; properties: Record<string, unknown> }

/** The 1.18.30 public TUI API backed by the existing session-data fixture. */
export function fakeLegacyTui() {
  const tui = fakeTui('1.18.30')
  const data = tui.ctx.data.session
  const listeners = new Map<string, Set<(input: { details: LegacyTuiEvent }) => void>>()
  const disposers: (() => Promise<void>)[] = []
  const on = vi.fn((type: string, listener: (input: { details: LegacyTuiEvent }) => void) => {
    const set = listeners.get(type) ?? new Set()
    set.add(listener)
    listeners.set(type, set)
    return () => set.delete(listener)
  })
  const api = {
    app: { version: '1.18.30' },
    route: {
      get current() {
        const route = tui.ctx.ui.router.current()
        return route.type === 'session'
          ? { name: 'session', params: { sessionID: route.sessionID } }
          : { name: 'home', params: {} }
      }
    },
    state: {
      session: {
        get: data.get,
        status: (id: string) => ({ type: data.status(id) === 'running' ? 'busy' : 'idle' }),
        permission: data.permission.list,
        question: data.form.list
      }
    },
    event: { on },
    lifecycle: { onDispose: (dispose: () => Promise<void>) => disposers.push(dispose) }
  }
  return {
    api,
    on,
    navigate: tui.navigate,
    loseEnd: tui.loseEnd,
    async dispose() {
      for (const dispose of disposers) {
        await dispose()
      }
    },
    listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
    emit(event: LegacyTuiEvent) {
      const properties = event.properties
      const sessionID = properties.sessionID
      if (event.type === 'session.created') {
        const info = properties.info
        tui.emit({
          type: 'session.created',
          data:
            typeof info === 'object' && info !== null
              ? { ...info, sessionID: 'id' in info ? info.id : undefined }
              : {}
        })
      } else if (event.type === 'session.status') {
        const status = properties.status
        const busy =
          typeof status === 'object' &&
          status !== null &&
          'type' in status &&
          status.type === 'busy'
        tui.emit({
          type: busy ? 'session.execution.started' : 'session.execution.succeeded',
          data: { sessionID }
        })
      } else if (event.type === 'session.idle') {
        tui.emit({ type: 'session.execution.succeeded', data: { sessionID } })
      } else if (event.type === 'question.asked') {
        tui.emit({ type: 'form.created', data: { form: properties } })
      } else if (event.type === 'question.replied' || event.type === 'question.rejected') {
        tui.emit({ type: 'form.replied', data: { ...properties, id: properties.requestID } })
      } else {
        tui.emit({ type: event.type, data: properties })
      }
      for (const listener of listeners.get(event.type) ?? []) {
        listener({ details: event })
      }
    }
  }
}
