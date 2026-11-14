import { expect, it, vi } from 'vitest'
import type { HostSessionState, WorkerContext } from './browser-extension-contexts'

vi.mock('electron', () => ({ webFrameMain: {} }))
import { dispatchBrowserExtensionEvent } from './browser-extension-event-dispatch'

it.each([750, 7500])(
  'dispatches one session event without visiting %i inactive profiles',
  (count) => {
    let visited = 0
    class SessionMap extends Map<Electron.Session, HostSessionState> {
      override *[Symbol.iterator]() {
        for (const entry of super[Symbol.iterator]()) {
          visited++
          yield entry
        }
        return undefined
      }
    }
    const sessions = new SessionMap()
    for (let index = 0; index < count; index++) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The dispatch fixture supplies the session identity and extension fields accessed by this path.
      sessions.set({} as Electron.Session, {
        browserProfileId: `cold-${index}`,
        frames: new Map(),
        workers: new Map()
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The dispatch fixture supplies the session identity and extension fields accessed by this path.
    const extension = { id: 'vault', manifest: {} } as Electron.Extension
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The dispatch fixture supplies the session identity and extension fields accessed by this path.
    const session = {
      extensions: { getExtension: () => extension }
    } as unknown as Electron.Session
    const send = vi.fn()
    const worker: WorkerContext = {
      extensionId: 'vault',
      scope: 'chrome-extension://vault/',
      events: new Set(['orcaStorageSession.onChanged']),
      filters: new Map(),
      running: null,
      stream: { send, close: () => {} },
      queue: [],
      starting: false
    }
    sessions.set(session, {
      browserProfileId: 'active',
      frames: new Map(),
      workers: new Map([['vault', worker]])
    })
    const get = vi.spyOn(sessions, 'get')
    const changes = [{ saved: { newValue: 'retained' } }]
    dispatchBrowserExtensionEvent(
      sessions,
      { session, extensionId: 'vault' },
      'orcaStorageSession',
      'onChanged',
      changes,
      vi.fn()
    )
    expect(visited).toBe(0)
    expect(get).toHaveBeenCalledOnce()
    expect(send.mock.calls).toEqual([
      [{ namespace: 'orcaStorageSession', event: 'onChanged', args: changes }]
    ])
  }
)
