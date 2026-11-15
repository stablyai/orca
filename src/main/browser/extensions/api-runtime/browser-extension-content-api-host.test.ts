import { afterEach, expect, it, vi } from 'vitest'
import { ensureHostSessionState, forgetHostSession } from './browser-extension-contexts'
import {
  beginBrowserExtensionExecution,
  retireBrowserExtensionExecution
} from './browser-extension-execution-authority'
import {
  handleBrowserExtensionContentRequest,
  emitBrowserExtensionContentSessionChange
} from './browser-extension-content-api-host'
import { setBrowserExtensionSessionAccess } from '../profile-storage/browser-extension-session-access'
import { decodeBrowserExtensionWireJson } from '../../../../shared/browser/extensions/browser-extension-worker-api'

vi.mock('node:fs/promises', () => ({ readFile: async () => '{"extensions":{}}' }))
vi.mock('./browser-extension-native-page', () => ({
  runBrowserExtensionNativePage: async () => ({ ok: true })
}))
vi.mock('./browser-extension-namespace-registry', () => ({ extensionHasPermission: () => true }))
vi.mock('./browser-extension-api-request', () => ({ handleBrowserExtensionApiRequest: vi.fn() }))

const sessions: Electron.Session[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await retireBrowserExtensionExecution(session, 'vault')
    forgetHostSession(session)
  }
})
function open() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the session identity, storage path and installed extension used by this transport.
  const session = {
    storagePath: '/unused-profile',
    extensions: { getExtension: vi.fn(() => ({ id: 'vault' })) }
  } as unknown as Electron.Session
  sessions.push(session)
  ensureHostSessionState(session, 'profile')
  const execution = beginBrowserExtensionExecution(session, 'vault', new AbortController().signal)
  return {
    session,
    execution,
    access: (accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS') =>
      setBrowserExtensionSessionAccess(session, 'vault', accessLevel, execution.controller.signal),
    subscribe: () =>
      handleBrowserExtensionContentRequest(
        session,
        new Request('https://orca-extension/events', {
          method: 'POST',
          body: `${JSON.stringify({ token: execution.contentToken, context: 'frame' })}\n`
        })
      )
  }
}
function decode(value: Uint8Array | undefined): unknown {
  return decodeBrowserExtensionWireJson(new TextDecoder().decode(value).trim())
}

it.each([100, 1000])(
  'bounds a paused content listener independently of %i committed notifications and recovers future listening',
  async (count) => {
    const owner = open()
    await owner.access('TRUSTED_AND_UNTRUSTED_CONTEXTS')
    const response = await owner.subscribe()
    const changes = { saved: { newValue: 'x'.repeat(1024 * 1024) } }
    for (let index = 0; index < count; index++) {
      emitBrowserExtensionContentSessionChange(owner.execution, changes)
    }
    const reader = response.body!.getReader()
    let bytes = 0
    let terminal: unknown
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        break
      }
      bytes += next.value.byteLength
      terminal = decode(next.value)
    }
    expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024 + 100)
    expect(terminal).toEqual({ control: 'overflow' })
    const recovered = (await owner.subscribe()).body!.getReader()
    emitBrowserExtensionContentSessionChange(owner.execution, {
      saved: { newValue: 'after recovery' }
    })
    expect(decode((await recovered.read()).value)).toEqual({
      namespace: 'orcaStorageSession',
      event: 'onChanged',
      args: [{ saved: { newValue: 'after recovery' } }]
    })
    await recovered.cancel()
  }
)

it('keeps a denied listener dormant, drops revoked backlog, and never replays denied history after regrant', async () => {
  const owner = open()
  const response = await owner.subscribe()
  expect(response.status).toBe(200)
  emitBrowserExtensionContentSessionChange(owner.execution, { denied: { newValue: true } })
  await owner.access('TRUSTED_AND_UNTRUSTED_CONTEXTS')
  emitBrowserExtensionContentSessionChange(owner.execution, { revoked: { newValue: true } })
  await owner.access('TRUSTED_CONTEXTS')
  await owner.access('TRUSTED_AND_UNTRUSTED_CONTEXTS')
  emitBrowserExtensionContentSessionChange(owner.execution, { allowed: { newValue: true } })
  const reader = response.body!.getReader()
  expect(decode((await reader.read()).value)).toEqual({
    namespace: 'orcaStorageSession',
    event: 'onChanged',
    args: [{ allowed: { newValue: true } }]
  })
  await retireBrowserExtensionExecution(owner.session, 'vault')
  expect(decode((await reader.read()).value)).toEqual({ control: 'retired' })
  expect((await reader.read()).done).toBe(true)
  expect((await owner.subscribe()).status).toBe(403)
})

it.each([10, 100])(
  'converts the native extension at most once per delivered event for %i listeners',
  async (count) => {
    const owner = open()
    await owner.access('TRUSTED_AND_UNTRUSTED_CONTEXTS')
    const readers = await Promise.all(
      Array.from({ length: count }, async () => (await owner.subscribe()).body!.getReader())
    )
    const pending = readers.map((reader) => reader.read())
    const getExtension = vi.mocked(owner.session.extensions.getExtension)
    getExtension.mockClear()
    emitBrowserExtensionContentSessionChange(owner.execution, { saved: { newValue: 'now' } })
    const delivered = await Promise.all(pending)
    expect(delivered.every((event) => decode(event.value) !== undefined)).toBe(true)
    // Include the empty pull after each delivered event.
    const empty = readers.map((reader) => reader.read())
    await Promise.resolve()
    expect(getExtension.mock.calls.length).toBeLessThanOrEqual(1 + count)
    await Promise.all(readers.map((reader) => reader.cancel()))
    await Promise.all(empty)
  }
)
