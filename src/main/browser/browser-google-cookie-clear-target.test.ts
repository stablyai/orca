import type * as ClientHostRuntime from './paired-runtime-browser-client-host-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { z } from 'zod'
import type {
  GoogleCookieClearLocalTarget,
  GoogleCookieClearTarget
} from '../../shared/browser-google-cookie-clear'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  BrowserCookieImportResult,
  BrowserSessionProfile
} from '../../shared/browser-workspace-types'

type ImportExecution = BrowserCookieImportResult & {
  executionMachine: 'client' | 'remote'
}
type BrowserTestStore = {
  setState(state: Record<string, unknown>): void
  getState(): {
    importCookiesFromBrowser(profileId: string, browserFamily: string): Promise<ImportExecution>
  }
}
let importStore: BrowserTestStore

const mocks = vi.hoisted(() => ({
  root: '',
  route: vi.fn(),
  profiles: new Map<string, BrowserSessionProfile>(),
  sessions: new Map<string, ReturnType<typeof jar>>(),
  import: vi.fn(),
  detect: vi.fn(),
  pick: vi.fn(),
  handlers: new Map<string, (event: { sender: unknown }, args: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
  BrowserWindow: { fromWebContents: () => null },
  session: { fromPartition: (partition: string) => mocks.sessions.get(partition) },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: (channel: string, handler: (event: { sender: unknown }, args: unknown) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('./paired-runtime-browser-client-host-runtime', () => ({
  getPairedRuntimeBrowserClientRouteIdentity: mocks.route
}))
vi.mock('./cookies/browser-cookie-import', () => ({
  importCookiesFromBrowser: mocks.import,
  importCookiesFromFile: mocks.import,
  pickCookieFile: mocks.pick,
  detectInstalledBrowsers: mocks.detect,
  selectBrowserProfile: vi.fn()
}))
vi.mock('./browser-manager', () => ({ browserManager: {} }))
vi.mock('./client-route-cookie-import-source-store', () => ({
  recordClientRouteCookieImportSource: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => importStore.getState() } }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
import { browserSessionRegistry } from './browser-session-registry'
vi.mock('./paired-runtime-browser-client-host-registry', () => ({
  PairedRuntimeBrowserClientHostRegistry: class {
    start = async () => ({})
    closeEnvironment = async () => true
    retireEnvironment = async () => true
  }
}))
const { publicRuntimeEnvironment } = await vi.importActual<{
  publicRuntimeEnvironment(
    fields: Pick<PublicKnownRuntimeEnvironment, 'id'> & Partial<PublicKnownRuntimeEnvironment>
  ): PublicKnownRuntimeEnvironment
}>('../../renderer/src/runtime/paired-runtime-environment-test-fixture')
const runtime = await vi.importActual<typeof ClientHostRuntime>(
  './paired-runtime-browser-client-host-runtime'
)

const { replaceRuntimeEnvironmentRevisions } = await vi.importActual<{
  replaceRuntimeEnvironmentRevisions(environments: PublicKnownRuntimeEnvironment[]): void
}>('../../renderer/src/runtime/runtime-environment-revision')
const { createTestStore } = await vi.importActual<{
  createTestStore(): BrowserTestStore
}>('../../renderer/src/store/slices/browser-slice-test-harness')
const { captureGoogleCookieClearTarget, confirmAndClearGoogleCookies } = await vi.importActual<{
  captureGoogleCookieClearTarget(
    hostId: string,
    profileId: string,
    label: undefined,
    remote: boolean
  ): Promise<{ target?: GoogleCookieClearTarget }>
  confirmAndClearGoogleCookies(
    target: GoogleCookieClearTarget,
    confirm: () => Promise<boolean>
  ): Promise<void>
}>('../../renderer/src/lib/browser-google-cookie-clear')
import { registerBrowserHandlers } from '../ipc/browser'
import { setTrustedBrowserRendererWebContentsId } from '../ipc/browser-renderer-trust'
import {
  bindRoutePartition,
  importCookiesIntoClientRoutePartition
} from './browser-client-route-cookie-import'
import { clearGoogleCookies } from './cookies/browser-google-cookie-clear'
import { acquireCookieMutationLock } from './cookies/browser-cookie-import-clear'
import { deriveBrowserRoutePartition } from './browser-route-identity'
import * as bindingFile from './browser-route-partition-binding-file'

const profile: BrowserSessionProfile = {
  id: 'work',
  partition: 'persist:work',
  label: 'Work',
  scope: 'isolated',
  source: null
}
const route = {
  orcaProfileId: 'orca',
  authorityConnectionIdentity: 'new',
  pairingAuthorityConnectionIdentity: 'old',
  legacyAuthorityConnectionIdentity: 'legacy',
  executionHostIdentity: 'desktop',
  legacyExecutionHostIdentity: 'legacy-desktop',
  storageScope: 'a'.repeat(64)
}
const request = { environmentId: 'server', browserProfileId: 'work', browserFamily: 'chrome' }
const targetSchema = z.object({
  profileId: z.string(),
  environmentId: z.string().nullable(),
  partition: z.string(),
  routeIdentity: z.string().nullable()
})
function call(channel: string, args: unknown, senderId = 91) {
  const handler = mocks.handlers.get(`browser:session:${channel}`)
  if (!handler) {
    throw new Error('missing IPC handler')
  }
  return handler(
    {
      sender: {
        id: senderId,
        isDestroyed: () => false,
        getType: () => 'window',
        getURL: () => 'file:///renderer/index.html'
      }
    },
    args
  )
}
function jar(count = 1) {
  let rows = [
    ...Array.from({ length: count }, (_, i) => ({
      name: `SID${i}`,
      domain: '.google.com',
      path: '/',
      secure: true
    })),
    { name: 'other', domain: 'example.com', path: '/', secure: true }
  ]
  const cookies = {
    get: vi.fn(async () =>
      rows.map((row) => ({ ...row, value: 'live', sameSite: 'unspecified' as const }))
    ),
    remove: vi.fn(async (_url: string, name: string) => {
      rows = rows.filter((row) => row.name !== name)
    })
  }
  return { cookies }
}
beforeEach(() => {
  mocks.root = mkdtempSync(join(tmpdir(), 'pr34158-binding-'))
  mocks.profiles.clear()
  mocks.profiles.set(profile.id, { ...profile })
  mocks.sessions.clear()
  mocks.route.mockReturnValue(route)
  mocks.detect.mockReturnValue([])
  mocks.import.mockResolvedValue({ ok: true, summary: {} })
  mocks.pick.mockResolvedValue('/fixture/cookies.json')
  vi.spyOn(browserSessionRegistry, 'getProfile').mockImplementation(
    (id) => mocks.profiles.get(id) ?? null
  )
  vi.spyOn(browserSessionRegistry, 'listProfiles').mockImplementation(() => [
    ...mocks.profiles.values()
  ])
  vi.spyOn(browserSessionRegistry, 'updateProfileSource').mockReturnValue(null)
  vi.spyOn(browserSessionRegistry, 'requireRouteBrowserProfile').mockImplementation((id) => {
    if (!mocks.profiles.has(id)) {
      throw new Error('profile unavailable')
    }
  })
  setTrustedBrowserRendererWebContentsId(91)
  registerBrowserHandlers()
})
afterEach(() => {
  replaceRuntimeEnvironmentRevisions([])
  browserSessionRegistry.onProfilesChanged = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(mocks.root, { recursive: true, force: true })
})

it('preserves import refusal/order, reserves delegation for absent routes, and rejects forged/untrusted IPC', async () => {
  const server = jar()
  mocks.sessions.set('persist:server', server)
  mocks.profiles.delete('work')
  expect(await importCookiesIntoClientRoutePartition(request)).toMatchObject({
    ok: false,
    reason: 'Session profile not found.'
  })
  expect(() =>
    call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })
  ).toThrow()
  expect(server.cookies.remove).not.toHaveBeenCalled()
  mocks.route.mockReturnValue(null)
  expect(call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })).toBeNull()
  expect(await importCookiesIntoClientRoutePartition(request)).toBeNull()
  mocks.profiles.set('work', profile)
  mocks.route.mockReturnValue(route)
  expect(await importCookiesIntoClientRoutePartition(request)).toMatchObject({
    ok: false,
    reason: 'Browser not found on this system.'
  })
  const target: GoogleCookieClearLocalTarget = targetSchema.parse(
    call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })
  )
  expect(() => call('clearGoogleCookies', { ...target, partition: 'persist:server' })).toThrow()
  expect(() => call('clearGoogleCookies', target, 92)).toThrow('Not authorized')
  expect(() => call('clearGoogleCookies', {})).toThrow()
  expect(() => call('clearGoogleCookies', { ...target, routeIdentity: 'forged' })).toThrow()
  expect(
    call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' }, 92)
  ).toBeNull()
  expect(() =>
    call('googleCookieClearTarget', { profileId: 'unknown', environmentId: null })
  ).toThrow()
  expect(server.cookies.get).not.toHaveBeenCalled()
})

it.each([
  [10, 50],
  [100, 500]
])(
  'bounds real binding-file work at K=%i B=%i and preserves alias-selected/non-Google jars',
  async (count, bindings) => {
    const entries = Object.fromEntries(
      Array.from({ length: bindings - 1 }, (_, i) => {
        const d = deriveBrowserRoutePartition({ ...route, browserProfileId: `unused-${i}` })
        return [
          d.partition,
          { fingerprint: d.bindingFingerprint, storageScope: route.storageScope, lastUsedAt: 1 }
        ]
      })
    )
    const compatible = deriveBrowserRoutePartition({
      ...route,
      browserProfileId: 'work',
      authorityConnectionIdentity: route.pairingAuthorityConnectionIdentity
    })
    entries[compatible.partition] = {
      fingerprint: compatible.bindingFingerprint,
      storageScope: route.storageScope,
      lastUsedAt: 1
    }
    writeFileSync(
      join(mocks.root, 'browser-route-partition-bindings.json'),
      JSON.stringify({ version: 2, bindings: entries })
    )
    const partition = bindRoutePartition(route, 'work')
    expect(partition).toBe(compatible.partition)
    const target: GoogleCookieClearLocalTarget = targetSchema.parse(
      call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })
    )
    const session = jar(count)
    session.cookies.get.mockResolvedValueOnce([
      ...(await session.cookies.get()),
      ...(await session.cookies.get()).filter((row) => row.name === 'SID0')
    ])
    session.cookies.get.mockClear()
    const decoy = jar()
    mocks.sessions.set(partition, session)
    mocks.sessions.set(profile.partition, decoy)
    const read = vi.spyOn(bindingFile, 'readBoundedUtf8File')
    expect(await call('clearGoogleCookies', target)).toBe('cleared')
    expect(read).toHaveBeenCalledTimes(4)
    expect(session.cookies.get).toHaveBeenCalledTimes(2)
    expect(session.cookies.remove).toHaveBeenCalledTimes(count)
    expect(await session.cookies.get()).toEqual([expect.objectContaining({ name: 'other' })])
    expect(decoy.cookies.get).not.toHaveBeenCalled()
    session.cookies.get.mockClear()
    expect(await call('clearGoogleCookies', target)).toBe('empty')
    expect(session.cookies.get).toHaveBeenCalledTimes(1)
  }
)

it.each(['between selectors', 'queued profile'])(
  'stops mutation after changed ownership: %s',
  async (change) => {
    const target: GoogleCookieClearLocalTarget = targetSchema.parse(
      call('googleCookieClearTarget', { profileId: 'work', environmentId: 'server' })
    )
    const session = jar(2)
    mocks.sessions.set(target.partition, session)
    if (change === 'between selectors') {
      session.cookies.remove.mockImplementationOnce(async () => {
        mocks.route.mockReturnValue({ ...route })
      })
      expect(await call('clearGoogleCookies', target)).toBe('unverified')
      expect(session.cookies.remove).toHaveBeenCalledTimes(1)
    } else {
      const release = await acquireCookieMutationLock(session)
      const clearing = call('clearGoogleCookies', target)
      mocks.profiles.delete('work')
      release()
      await expect(clearing).rejects.toThrow('connection changed')
      expect(session.cookies.get).not.toHaveBeenCalled()
    }
  }
)

import { browserProfileRpcFixture } from '../runtime/browser/browser-profile-rpc-test-fixture'
import { RuntimeBrowserProfiles } from '../runtime/browser/browser-profiles'
it('validates required executor params at the dispatcher before owner entry', async () => {
  const clear = vi.spyOn(RuntimeBrowserProfiles.prototype, 'browserProfileClearGoogleCookies')
  const { dispatcher } = browserProfileRpcFixture('S1')
  expect(
    await dispatcher.dispatch({
      id: 'clear',
      authToken: 'fixture',
      method: 'browser.profileClearGoogleCookies',
      params: { profileId: 'work' }
    })
  ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  expect(clear).not.toHaveBeenCalled()
  expect(
    await dispatcher.dispatch({
      id: 'valid-clear',
      authToken: 'fixture',
      method: 'browser.profileClearGoogleCookies',
      params: { profileId: 'absent', executorRuntimeId: 'S1' }
    })
  ).toMatchObject({ ok: false, error: { message: expect.stringContaining('not found') } })
  expect(clear).toHaveBeenCalledTimes(1)
})

it.each(['reject after delete', 'first read', 'last read'])(
  'reports observed cookie truth through the selected Session: %s',
  async (fault) => {
    const session = jar(2)
    const remove = session.cookies.remove.getMockImplementation()!
    if (fault === 'reject after delete') {
      session.cookies.remove.mockImplementationOnce(async (url, name) => {
        await remove(url, name)
        throw new Error('deleted then rejected')
      })
    }
    if (fault === 'first read' || fault === 'last read') {
      if (fault === 'last read') {
        session.cookies.get.mockResolvedValueOnce(await session.cookies.get())
      }
      session.cookies.get.mockRejectedValueOnce(new Error('read failed'))
    }
    expect(await clearGoogleCookies(session)).toBe(
      fault.includes('read') ? 'unverified' : 'cleared'
    )
    if (!fault.includes('read')) {
      expect(session.cookies.remove).toHaveBeenCalledTimes(2)
    }
  }
)

it('retains actual local/file/client import destinations, source-only replacement, and real route retirement', async () => {
  vi.mocked(browserSessionRegistry.getProfile).mockRestore()
  vi.mocked(browserSessionRegistry.updateProfileSource).mockRestore()
  vi.mocked(browserSessionRegistry.requireRouteBrowserProfile).mockRestore()
  browserSessionRegistry.configureForOrcaProfile({
    orcaProfileId: 'orca',
    profileDirectory: mocks.root
  })
  const selected = browserSessionRegistry.getDefaultProfile()
  mocks.detect.mockReturnValue([{ family: 'chrome', selectedProfile: 'Default', profiles: [] }])
  for (const channel of ['importCookies', 'importFromBrowser']) {
    expect(await call(channel, { profileId: 'default', browserFamily: 'chrome' })).toMatchObject({
      ok: true,
      googleCookieClearTarget: { local: { partition: selected.partition } }
    })
    expect(mocks.import.mock.calls.at(-1)?.[1]).toBe(selected.partition)
  }
  const changed = vi.fn()
  browserSessionRegistry.onProfilesChanged = changed
  runtime.configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'orca' })
  await runtime.startPairedRuntimeBrowserClientHost({
    authorityRuntimeId: 'D',
    environment: {
      ...publicRuntimeEnvironment({ id: 'server', runtimeId: 'D' }),
      endpoints: [
        {
          id: 'ws-1',
          kind: 'websocket',
          label: 'Fixture',
          endpoint: 'ws://localhost:9999',
          deviceToken: 'fixture',
          publicKeyB64: 'fixture'
        }
      ]
    }
  })
  expect(changed).toHaveBeenCalledTimes(1)
  mocks.route.mockImplementation(runtime.getPairedRuntimeBrowserClientRouteIdentity)
  const remoteCall = vi.fn()
  const localClear = vi.fn(async (args: unknown) => call('clearGoogleCookies', args))
  vi.stubGlobal('window', {
    api: {
      browser: {
        sessionImportFromBrowserForClientHost: (args: unknown) =>
          call('importFromBrowserForClientHost', args),
        sessionGoogleCookieClearTarget: (args: unknown) => call('googleCookieClearTarget', args),
        sessionClearGoogleCookies: localClear
      },
      runtimeEnvironments: { call: remoteCall }
    }
  })
  replaceRuntimeEnvironmentRevisions([publicRuntimeEnvironment({ id: 'server' })])
  importStore = createTestStore()
  importStore.setState({
    browserSessionHostIdOverride: 'runtime:server',
    runtimeEnvironments: [publicRuntimeEnvironment({ id: 'server' })],
    runtimeStatusByEnvironmentId: new Map([
      ['server', { checkedAt: 1, status: { capabilities: [] } }]
    ]),
    fetchBrowserSessionProfiles: vi.fn(async () => {})
  })
  const result = await importStore.getState().importCookiesFromBrowser('default', 'chrome')
  expect(result).toMatchObject({ ok: true, executionMachine: 'client' })
  const target = targetSchema.parse(result?.ok ? result.googleCookieClearTarget?.local : null)
  expect(target.partition).toBe(mocks.import.mock.calls.at(-1)?.[1])
  const session = jar(2)
  mocks.sessions.set(target.partition, session)
  session.cookies.remove.mockImplementationOnce(async () => {
    browserSessionRegistry.updateProfileSource('default', {
      browserFamily: 'manual',
      importedAt: 1
    })
  })
  expect(target).toMatchObject({ environmentId: 'server', routeIdentity: expect.any(String) })
  const captured = await captureGoogleCookieClearTarget(
    'runtime:server',
    'default',
    undefined,
    true
  )
  expect(captured.target).toEqual(result.ok ? result.googleCookieClearTarget : undefined)
  const confirm = vi.fn(async () => true)
  if (!captured.target) {
    throw new Error('missing target')
  }
  await confirmAndClearGoogleCookies(captured.target, confirm)
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(localClear).toHaveBeenCalledWith(target)
  expect(await localClear.mock.results[0]?.value).toBe('remaining')
  expect(remoteCall).not.toHaveBeenCalled()
  expect(session.cookies.remove).toHaveBeenCalledTimes(2)
  expect(browserSessionRegistry.getProfile('default')).not.toBe(selected)
  const release = await acquireCookieMutationLock(session)
  const clearing = call('clearGoogleCookies', target)
  changed.mockClear()
  await runtime.retirePairedRuntimeBrowserClientHostEnvironment('server')
  expect(changed).toHaveBeenCalledTimes(1)
  session.cookies.get.mockClear()
  release()
  await expect(clearing).rejects.toThrow('connection changed')
  expect(session.cookies.get).not.toHaveBeenCalled()
  writeFileSync(join(mocks.root, 'browser-route-partition-bindings.json'), 'corrupt')
  mocks.route.mockReturnValue(route)
  const read = vi.spyOn(bindingFile, 'readBoundedUtf8File')
  expect(
    await importCookiesIntoClientRoutePartition({
      ...request,
      browserProfileId: 'default',
      browserProfile: '../invalid'
    })
  ).toMatchObject({ ok: false, reason: 'Invalid browser profile name.' })
  expect(read).not.toHaveBeenCalled()
})
