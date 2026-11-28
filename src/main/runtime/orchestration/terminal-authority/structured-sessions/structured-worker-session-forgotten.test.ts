import { afterEach, expect, it } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredWorkerSessionForgotten } from './structured-worker-authority'
import { structuredWorkerProcessIncarnation } from './structured-worker-incarnation'

const SESSION = '9412200c-0000-4000-8000-000000000001'

// The host is process-wide: a shared test runner must not hand this partial one to the next file.
afterEach(() => setStructuredAgentSessionHost(null))

function installStore(store: {
  readOnly?: boolean
  record?: boolean
  unreadable?: boolean
  open?: boolean
}): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forgotten check reads only `hasSession` and the store's `readOnly`, `getRecord` and `isSessionUnreadable`.
  setStructuredAgentSessionHost({
    hasSession: (id: string) => id === SESSION && store.open === true,
    deps: {
      store: {
        readOnly: store.readOnly === true,
        getRecord: (id: string) => (id === SESSION && store.record ? { sessionId: id } : null),
        isSessionUnreadable: (id: string) => id === SESSION && store.unreadable === true
      }
    }
  } as never)
}

it.each([
  { name: 'gone from a writable store', store: {}, forgotten: true },
  { name: 'still recorded', store: { record: true }, forgotten: false },
  { name: 'recorded but unreadable', store: { unreadable: true }, forgotten: false },
  { name: 'open on the host', store: { open: true }, forgotten: false },
  { name: 'read from a newer build', store: { readOnly: true }, forgotten: false }
])('proves a chat worker ended only when its session is $name', ({ store, forgotten }) => {
  installStore(store)

  expect(structuredWorkerSessionForgotten(structuredWorkerProcessIncarnation(SESSION))).toBe(
    forgotten
  )
})

it('proves nothing without an installed host or for a terminal worker', () => {
  expect(structuredWorkerSessionForgotten(structuredWorkerProcessIncarnation(SESSION))).toBe(false)

  installStore({})
  expect(structuredWorkerSessionForgotten('pty:some-incarnation')).toBe(false)
  expect(structuredWorkerSessionForgotten(null)).toBe(false)
})
