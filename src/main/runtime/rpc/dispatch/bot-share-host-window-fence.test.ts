// A teammate with the workspace tier (here by the dev-only switch on a paired desktop) opens pages on
// their own computer, and nothing they call reaches the host's window.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { OrcaRuntimeService } from '../../orca-runtime'
import { z } from 'zod'
import { RpcDispatcher } from '../dispatcher'
import { defineMethod, type RpcAnyMethodDeclaration } from '../core'
import { ALL_RPC_METHODS } from '../methods/rpc-method-registry'
import { callerScopeOf } from '../server/pairing/device-principal'
import { reachesHostWindow } from '../../../bots/team-share/teammate-rules'
import { getRuntimeBrowserPageRegistry } from '../../browser/client-pages/runtime-browser-page-registry'

const callerOf = (runtime: OrcaRuntimeService) => ({
  pageDeviceOf: (page: string) =>
    getRuntimeBrowserPageRegistry(runtime).getPage(page)?.pairedDeviceId
})

let dispatcher: RpcDispatcher
const ran: string[] = []

const clientPage = (browserPageId: string, pairedDeviceId: string) => ({
  browserPageId,
  workspaceId: 'wt',
  browserProfileId: 'default',
  executionHostKey: 'native',
  placement: {
    kind: 'client' as const,
    browserHostClientId: `${pairedDeviceId}-host`,
    browserHostGeneration: 1,
    pageHostGeneration: 1
  },
  pairedDeviceId,
  url: 'https://example.com',
  loading: false,
  active: false
})

beforeEach(() => {
  vi.stubEnv('ORCA_TEST_PAIRED_DEVICE_AS_TEAMMATE', '1')
  const runtime = new OrcaRuntimeService()
  getRuntimeBrowserPageRegistry(runtime).publishClientPage(clientPage('own-page', 'desk-b'))
  getRuntimeBrowserPageRegistry(runtime).publishClientPage(clientPage('owners-page', 'desk-owner'))
  // Orchestration methods keep their own access check; none of these cases needs one.
  const methods: RpcAnyMethodDeclaration[] = ALL_RPC_METHODS.filter(
    (method) => !method.name.startsWith('orchestration.')
  )
  methods.push(
    defineMethod({
      name: 'test.unclassified',
      permission: 'workspace',
      share: 'not-shared',
      params: z.object({}),
      handler: () => ({})
    })
  )
  // Real names, permissions, shares and param schemas; handlers that only say they ran.
  dispatcher = new RpcDispatcher({
    runtime,
    methods: methods.map((method): RpcAnyMethodDeclaration => ({
      ...method,
      handler: () => {
        ran.push(method.name)
        return { ran: true }
      }
    }))
  })
})

afterEach(() => {
  installFakeAppEnvironment()
  vi.unstubAllEnvs()
  ran.length = 0
})

const DESK_B = {
  deviceId: 'desk-b',
  name: 'Desk B',
  scope: 'runtime',
  pairedAt: 0,
  lastSeenAt: 0
} as const

const asPairedDesktop = (method: string, params: unknown) =>
  dispatcher.dispatch(
    { id: 'r1', authToken: '', method, params },
    {
      callerScope: callerScopeOf(DESK_B),
      pairedDeviceId: 'desk-b',
      clientKind: 'runtime'
    }
  )

const HOST_WINDOW_REFUSED = { error: { message: expect.stringContaining('their own computer') } }

const CLIENT_PLACEMENT = { kind: 'client', browserHostClientId: 'desk-b-host' }

it('opens a page on the teammate’s own computer, never on the host’s window', async () => {
  const own = await asPairedDesktop('browser.tabCreate', {
    url: 'https://example.com',
    placement: CLIENT_PLACEMENT
  })
  // Past the host-window check, the tier's own check may still refuse a workspace not the agent's.
  expect(own).not.toMatchObject(HOST_WINDOW_REFUSED)
  for (const [method, params] of [
    ['browser.tabCreate', { url: 'https://example.com' }],
    ['browser.tabCreate', { url: 'https://example.com', placement: { kind: 'server' } }],
    ['browser.tabCreate', { placement: CLIENT_PLACEMENT, navigation: 'all' }],
    ['browser.openUrl', { url: 'https://example.com', worktree: 'id:wt' }],
    ['browser.tabProfileClone', { profileId: 'p' }],
    ['session.tabs.activate', { worktree: 'id:wt', tabId: 't', navigation: 'host' }],
    ['terminal.focus', { terminal: 't', navigation: 'host' }],
    // Pageless commands fall back to the host's active tab; another computer's page isn't theirs.
    ['browser.goto', { url: 'https://example.com' }],
    ['browser.goto', { url: 'https://example.com', page: 'owners-page' }],
    ['browser.tabClose', { page: 'owners-page' }],
    ['browser.tabSwitch', { page: 'own-page', focus: true }],
    ['files.open', { worktree: 'id:wt', relativePath: 'a.ts', navigation: 'caller' }],
    ['terminal.split', { terminal: 't' }],
    ['agentSession.reveal', { sessionId: '00000000-0000-4000-8000-000000000001' }],
    ['worktree.create', { repo: 'id:r', name: 'n', activate: true }],
    // Running its hooks activates the new workspace as `activate` does.
    ['worktree.create', { repo: 'id:r', name: 'n', runHooks: true }]
  ] as const) {
    const refused = await asPairedDesktop(method, params)
    expect(refused, `${method} ${JSON.stringify(params)}`).toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: expect.stringContaining('their own computer') }
    })
  }
  expect(ran.filter((method) => method !== 'browser.tabCreate')).toEqual([])
})

it('never streams a host page to a teammate', async () => {
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    { id: 's1', authToken: '', method: 'browser.screencast', params: { page: 'own-page' } },
    (reply) => replies.push(reply),
    { callerScope: callerScopeOf(DESK_B), pairedDeviceId: 'desk-b', clientKind: 'runtime' }
  )
  expect(JSON.parse(replies[0]!)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
})

it('drives only pages on the teammate’s own computer', async () => {
  for (const [method, params] of [
    ['browser.goto', { url: 'https://example.com', page: 'own-page' }],
    ['browser.tabSwitch', { page: 'own-page' }],
    ['browser.tabClose', { page: 'own-page' }]
  ] as const) {
    // Admitted: past the fence, a real check may still answer (goto needs a live page host).
    expect(await asPairedDesktop(method, params), method).not.toMatchObject(HOST_WINDOW_REFUSED)
  }
})

it('lets a call that moves only the teammate’s own screen past the host-window check', async () => {
  // Past it, the tier's own check refuses a workspace that isn't the agent's.
  const activated = await asPairedDesktop('session.tabs.activate', {
    worktree: 'id:wt',
    tabId: 't',
    navigation: 'caller'
  })
  expect(activated).not.toMatchObject({
    error: { message: expect.stringContaining('their own computer') }
  })
})

it('leaves the tier’s refusals of the host’s own screen in place', async () => {
  for (const [method, params] of [
    ['browser.screencast.reclaimForDesktop', { browserPageId: 'owners-page', all: true }],
    ['emulator.attach', {}],
    ['ui.set', { sidebarOpen: false }],
    ['settings.update', { key: 'x', value: 1 }],
    ['test.unclassified', {}]
  ] as const) {
    expect(await asPairedDesktop(method, params), method).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
  }
  expect(ran).toEqual([])
  // The host-window check refuses an unclassified method on its own too, for either tier.
  expect(reachesHostWindow('test.unclassified', {}, callerOf(new OrcaRuntimeService()))).toBe(true)
})

it('is never a teammate in a shipped build, whatever the switch says', () => {
  installFakeAppEnvironment({ isPackaged: () => true })
  expect(callerScopeOf(DESK_B)).toMatchObject({ kind: 'runtime-paired' })
})

it('reads each param on its own, and matches no page to a caller without a device', () => {
  const runtime = new OrcaRuntimeService()
  // A same-named key of another shape (agent.launch's placement) must not hide `navigation`.
  expect(
    reachesHostWindow(
      'session.tabs.activate',
      { worktree: 'id:wt', tabId: 't', navigation: 'host', placement: { groupId: 'g' } },
      callerOf(runtime)
    )
  ).toBe(true)
  const { pairedDeviceId: _, ...anonymous } = clientPage('anonymous-page', 'unused')
  getRuntimeBrowserPageRegistry(runtime).publishClientPage(anonymous)
  expect(reachesHostWindow('browser.goto', { page: 'anonymous-page' }, callerOf(runtime))).toBe(
    true
  )
})
