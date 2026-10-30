import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '', emit: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData, on: vi.fn() } }))
vi.mock('./browser-extension-api-host', () => ({
  emitBrowserExtensionWorkerStartEvent: mocks.emit
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-lifecycle-'))

const { decideRuntimeLifecycleEvents, fireRuntimeLifecycleEvents } =
  await import('./browser-extension-runtime-lifecycle')
const { getBrowserExtensionProfileStateStore } =
  await import('./browser-extension-profile-state-store')

const loaded = (extensionVersion: string, chromiumVersion = '140.0.0.0') => ({
  extensionVersion,
  chromiumVersion
})
const install = { event: 'onInstalled', args: [{ reason: 'install' }] }
const startup = { event: 'onStartup', args: [] }

describe('decideRuntimeLifecycleEvents', () => {
  it('installs on the first load in a profile, with no onStartup even at launch', () => {
    expect(decideRuntimeLifecycleEvents(undefined, loaded('1.0'), 'startup')).toEqual([install])
    expect(decideRuntimeLifecycleEvents(undefined, loaded('1.0'), 'other')).toEqual([install])
  })

  it('fires only onStartup when an installed extension loads at launch unchanged', () => {
    expect(decideRuntimeLifecycleEvents(loaded('1.0'), loaded('1.0'), 'startup')).toEqual([startup])
    expect(decideRuntimeLifecycleEvents(loaded('1.0'), loaded('1.0'), 'other')).toEqual([])
  })

  it('reports a new version, or any reload, as an update with the previous version', () => {
    const update = { event: 'onInstalled', args: [{ reason: 'update', previousVersion: '1.0' }] }
    expect(decideRuntimeLifecycleEvents(loaded('1.0'), loaded('2.0'), 'reload')).toEqual([update])
    expect(decideRuntimeLifecycleEvents(loaded('1.0'), loaded('1.0'), 'reload')).toEqual([update])
    expect(decideRuntimeLifecycleEvents(loaded('1.0'), loaded('2.0'), 'startup')).toEqual([
      startup,
      update
    ])
  })

  it('reports a new Chromium under the same extension version as chrome_update', () => {
    expect(
      decideRuntimeLifecycleEvents(loaded('1.0', '139.0'), loaded('1.0', '140.0'), 'startup')
    ).toEqual([startup, { event: 'onInstalled', args: [{ reason: 'chrome_update' }] }])
  })
})

describe('fireRuntimeLifecycleEvents', () => {
  const session: Electron.Session = Object.create(null)
  const extension = (version: string, background: unknown = { service_worker: 'w.js' }) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the firing reads only id, version and manifest.background.
    ({ id: 'a'.repeat(32), version, manifest: { background } }) as unknown as Electron.Extension

  beforeEach(() => {
    mocks.emit.mockClear()
    getBrowserExtensionProfileStateStore().forgetExtension('a'.repeat(32))
  })

  it('records what it fired so the same launch never fires it twice', () => {
    fireRuntimeLifecycleEvents(session, 'default', extension('1.0'), 'other')
    fireRuntimeLifecycleEvents(session, 'default', extension('1.0'), 'other')
    expect(mocks.emit.mock.calls).toEqual([
      [session, 'a'.repeat(32), 'runtime', 'onInstalled', [{ reason: 'install' }]]
    ])
    expect(
      getBrowserExtensionProfileStateStore().read('default', 'a'.repeat(32)).lastLoaded
    ).toEqual({ extensionVersion: '1.0', chromiumVersion: process.versions.chrome })
  })

  it('keeps each profile apart and is cleared with the extension', () => {
    fireRuntimeLifecycleEvents(session, 'default', extension('1.0'), 'other')
    fireRuntimeLifecycleEvents(session, 'work', extension('1.0'), 'startup')
    getBrowserExtensionProfileStateStore().forgetExtension('a'.repeat(32))
    fireRuntimeLifecycleEvents(session, 'default', extension('1.0'), 'startup')
    expect(mocks.emit.mock.calls.map((call) => [call[3], call[4]])).toEqual([
      ['onInstalled', [{ reason: 'install' }]],
      ['onInstalled', [{ reason: 'install' }]],
      ['onInstalled', [{ reason: 'install' }]]
    ])
  })

  it('records but raises nothing for an extension without a service worker', () => {
    fireRuntimeLifecycleEvents(session, 'default', extension('1.0', null), 'other')
    expect(mocks.emit).not.toHaveBeenCalled()
    expect(
      getBrowserExtensionProfileStateStore().read('default', 'a'.repeat(32)).lastLoaded
    ).toBeDefined()
  })
})
