// A teammate's page asking for 0.0.0.0/[::] (a dev server's printed wildcard) reaches the host's
// loopback, not this machine, through the session's one request listener.
import { expect, it } from 'vitest'
import type { Session } from 'electron'
import {
  installBrowserSessionRequestGate,
  removeBrowserSessionRequestGate,
  setBrowserSessionRedirectUnspecifiedToLoopback
} from './browser-session-request-gate'

type Listener = (
  details: { url: string },
  callback: (response: Electron.CallbackResponse) => void
) => void

const isListener = (value: unknown): value is Listener | null =>
  value === null || typeof value === 'function'
const isFilter = (value: unknown): value is Electron.WebRequestFilter =>
  typeof value === 'object' && value !== null && 'urls' in value

it('sends a teammate page’s 0.0.0.0 and [::] to loopback, and leaves other requests alone', () => {
  let held: { filter?: Electron.WebRequestFilter; listener: Listener | null } = { listener: null }
  const webRequest = {
    onBeforeRequest: (first: unknown, second?: unknown) => {
      const listener = second === undefined ? first : second
      held = {
        listener: isListener(listener) ? listener : null,
        ...(isFilter(first) ? { filter: first } : {})
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only webRequest and extensions.
  const session = { webRequest } as unknown as Session
  installBrowserSessionRequestGate(session)
  setBrowserSessionRedirectUnspecifiedToLoopback(session, true)
  const answer = (url: string) => {
    let response: Electron.CallbackResponse | undefined
    held.listener?.({ url }, (value) => (response = value))
    return response
  }
  expect(answer('http://0.0.0.0:5173/app?x=1')).toEqual({
    redirectURL: 'http://127.0.0.1:5173/app?x=1'
  })
  expect(answer('http://[::]:8080/')).toEqual({ redirectURL: 'http://[::1]:8080/' })
  expect(answer('ws://0.0.0.0:5173/hmr')).toEqual({ cancel: true })
  // Only those addresses are listened for, so other requests never wait on main.
  expect(held.filter?.urls).toContain('http://0.0.0.0/*')
  // One of your own computers: nothing is listened for.
  setBrowserSessionRedirectUnspecifiedToLoopback(session, false)
  expect(held.listener).toBeNull()
  removeBrowserSessionRequestGate(session)
})
