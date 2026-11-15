import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { ensureHostSessionState, forgetHostSession } from './browser-extension-contexts'
import {
  beginBrowserExtensionExecution,
  retireBrowserExtensionExecution
} from './browser-extension-execution-authority'

type Script = { id: string; js?: string[]; world?: string; matches?: string[] }
const native = vi.hoisted(() => {
  const scripts: Record<string, unknown>[] = []
  return { run: vi.fn(), scripts }
})
vi.mock('./browser-extension-native-page', () => ({
  runBrowserExtensionNativePage: (options: { code: string }) => native.run(options)
}))
vi.mock('../profile-storage/browser-extension-profile-state-store', () => ({
  getBrowserExtensionProfileStateStore: () => ({
    read: () => ({ contentScripts: native.scripts }),
    update: () => undefined
  })
}))

const { runBrowserExtensionContentScriptMethod: call, forgetBrowserExtensionContentScriptRestore } =
  await import('./browser-extension-content-scripts')

it('inherits MAIN for partial JS updates and normalizes explicit world-only transitions', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only session identity is used by this fixture.
  const session = {} as Electron.Session
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Content-script registration reads only the extension id.
  const extension = { id: 'vault' } as Electron.Extension
  ensureHostSessionState(session, 'scripts')
  const execution = beginBrowserExtensionExecution(
    session,
    extension.id,
    new AbortController().signal
  )
  const registered = new Map<string, Script>()
  const scripting = {
    registerContentScripts: (scripts: Script[], done: () => void) => {
      for (const script of scripts) {
        registered.set(script.id, structuredClone(script))
      }
      done()
    },
    updateContentScripts: (scripts: Script[], done: () => void) => {
      for (const script of scripts) {
        registered.set(script.id, { ...registered.get(script.id), ...structuredClone(script) })
      }
      done()
    },
    getRegisteredContentScripts: (done: (scripts: Script[]) => void) => {
      done(structuredClone([...registered.values()]))
    }
  }
  native.run.mockImplementation(({ code }: { code: string }) =>
    runInNewContext(code, { chrome: { scripting } })
  )
  const visit = (): { main: Record<string, unknown>; isolated: Record<string, unknown> } => {
    const main: Record<string, unknown> = {}
    const isolated: Record<string, unknown> = {}
    for (const script of registered.values()) {
      const world = script.world === 'MAIN' ? main : isolated
      for (const file of script.js ?? []) {
        runInNewContext(
          file === execution.contentScriptFile
            ? 'globalThis.bootstrapCredential = "secret"'
            : 'globalThis.updated = true',
          world
        )
      }
    }
    return { main, isolated }
  }
  try {
    await call(session, 'scripts', extension, 'registerContentScripts', [
      [{ id: 'page', world: 'MAIN', matches: ['https://site.example/*'], js: ['a.js'] }]
    ])
    await call(session, 'scripts', extension, 'updateContentScripts', [
      [{ id: 'page', js: ['b.js'] }]
    ])
    expect(visit()).toEqual({ main: { updated: true }, isolated: {} })
    expect(await call(session, 'scripts', extension, 'getRegisteredContentScripts', [])).toEqual([
      { id: 'page', world: 'MAIN', matches: ['https://site.example/*'], js: ['b.js'] }
    ])

    await call(session, 'scripts', extension, 'updateContentScripts', [
      [{ id: 'page', world: 'ISOLATED' }]
    ])
    expect(visit()).toEqual({
      main: {},
      isolated: { bootstrapCredential: 'secret', updated: true }
    })
    await call(session, 'scripts', extension, 'updateContentScripts', [
      [{ id: 'page', world: 'MAIN' }]
    ])
    expect(visit()).toEqual({ main: { updated: true }, isolated: {} })
    expect(await call(session, 'scripts', extension, 'getRegisteredContentScripts', [])).toEqual([
      { id: 'page', world: 'MAIN', matches: ['https://site.example/*'], js: ['b.js'] }
    ])
  } finally {
    forgetBrowserExtensionContentScriptRestore(session, extension.id)
    await retireBrowserExtensionExecution(session, extension.id)
    forgetHostSession(session)
  }
})

it.each([100, 1000])('indexes %i registered scripts once for batch updates', async (count) => {
  for (const partial of [false, true]) {
    let visits = 0
    native.scripts = Array.from({ length: count }, (_, index) => ({
      get id() {
        visits++
        return `script-${index}`
      },
      world: 'MAIN',
      js: ['a.js']
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture uses only session identity.
    const session = {} as Electron.Session
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The scripting call uses only the id.
    const extension = { id: 'vault' } as Electron.Extension
    ensureHostSessionState(session, 'batch')
    beginBrowserExtensionExecution(session, extension.id, new AbortController().signal)
    native.run.mockResolvedValue({ ok: true, scripts: [], value: undefined })
    try {
      await call(session, 'batch', extension, 'updateContentScripts', [
        Array.from({ length: count }, (_, index) => ({
          id: `script-${index}`,
          js: ['b.js'],
          ...(partial ? {} : { world: 'MAIN' })
        }))
      ])
      expect(visits).toBeLessThanOrEqual(4 * count)
    } finally {
      native.scripts = []
      forgetBrowserExtensionContentScriptRestore(session, extension.id)
      await retireBrowserExtensionExecution(session, extension.id)
      forgetHostSession(session)
    }
  }
})
