import { expect, it, vi } from 'vitest'
import type { HostSessionState, WorkerContext } from './browser-extension-contexts'

vi.mock('electron', () => ({ webFrameMain: {} }))
import {
  ensureHostSessionState,
  ensureWorkerContext,
  browserExtensionEventHasListener,
  forgetHostSession
} from './browser-extension-contexts'
import { beginWorkerPublication } from './browser-extension-worker-event-stream'
import { registerBrowserExtensionNamespace } from './browser-extension-namespace-registry'
registerBrowserExtensionNamespace('webRequest', {
  permission: 'webRequest',
  methods: {},
  events: ['onBeforeRequest']
})
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
      stream: {
        connectionId: 'fixture',
        controller: new AbortController(),
        events: new Set(['orcaStorageSession.onChanged']),
        filters: new Map(),
        published: true,
        send,
        close: () => {}
      },
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

it.each([10, 100])(
  'skips native manifests and request details for %i irrelevant workers',
  (count) => {
    const getExtension = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the native lookup is available so eager conversion would be observed.
    const session = { extensions: { getExtension } } as unknown as Electron.Session
    const state = ensureHostSessionState(session, 'hot')
    for (let index = 0; index < count; index++) {
      const context = ensureWorkerContext(state, String(index), '')
      context.extension = {
        id: String(index),
        name: '',
        version: '1',
        path: '',
        url: '',
        manifest: { permissions: [] }
      }
    }
    expect(browserExtensionEventHasListener(session, 'webRequest', 'onBeforeRequest')).toBe(false)
    for (const context of state.workers.values()) {
      beginWorkerPublication(context)
    }
    expect(browserExtensionEventHasListener(session, 'webRequest', 'onBeforeRequest')).toBe(false)
    const eligible = state.workers.get('0')!
    eligible.extension!.manifest.permissions = ['webRequest']
    expect(browserExtensionEventHasListener(session, 'webRequest', 'onBeforeRequest')).toBe(true)
    expect(getExtension).not.toHaveBeenCalled()
    forgetHostSession(session)
  }
)
