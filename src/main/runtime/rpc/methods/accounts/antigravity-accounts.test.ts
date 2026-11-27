import { expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { credential, harness } from '../../../../antigravity/native-account-test-fixtures'
import {
  antigravityHostAccountHome,
  antigravityHostCatalogFingerprints
} from '../../../../antigravity/antigravity-host-acp'
import { agentModelCatalogFingerprint } from '../../../../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { agentModelCatalogStore as store } from '../../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { parseAgyModelListing } from '../../../../antigravity/antigravity-model-listing'

const agy = vi.hoisted(() => new Map<string, unknown>())
const login = vi.hoisted(() => {
  const state: {
    shared: boolean
    env: Promise<NodeJS.ProcessEnv>
    launchStore?: Promise<boolean>
  } = { shared: true, env: Promise.resolve({ HOME: '/Users/shell-home' }) }
  return state
})
vi.mock('../../../agent-session/launch/structured-agent-launch-support', async (original) => ({
  ...(await original<object>()),
  resolveHostStructuredAgentLaunchEnvironment: () => login.env
}))
vi.mock('../../../../antigravity/native-file-credentials', async (original) => ({
  ...(await original<object>()),
  // Orca's own environment by `login.shared`; a launch environment by agy's own SSH rule.
  antigravityUsesFileStoreAsync: async (env: NodeJS.ProcessEnv) =>
    env === process.env ? !login.shared : (login.launchStore ?? Boolean(env.SSH_TTY))
}))
vi.mock('../../../../antigravity/native-account-host', () => ({
  getAntigravityAccountService: async (target: { runtime: string }) => agy.get(target.runtime)
}))
const { ANTIGRAVITY_ACCOUNT_METHODS } = await import('./antigravity-accounts')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: select reaches the runtime only to show the chat backend, which catches a failed read.
const context: RpcContext = { runtime: {} as RpcContext['runtime'], caller: { kind: 'local-cli' } }
const select = eraseRpcMethods(ANTIGRAVITY_ACCOUNT_METHODS).find(
  (method) => method.name === 'accounts.antigravitySelect'
)!
const models = parseAgyModelListing('gemini-4-neon-high\tGemini 4 Neon (high)')
const saveCatalog = (fingerprint: string) => {
  store.recordSuccess(fingerprint, 'antigravity', { models, origin: 'probe' }, 'discovery')
  store.recordSuccess(fingerprint, 'antigravity', { models, origin: 'live-session' }, 'live')
}
async function accounts() {
  const native = harness(credential('a'))
  await native.service.addCurrentAccount()
  native.setNative(credential('b'))
  const { accounts } = await native.service.addCurrentAccount()
  native.setNative(credential('a'))
  const id = (subject: string) => accounts.find((row) => row.subject === subject)!.id
  return { ...native, a: id('a'), b: id('b') }
}

it("selecting another host account lists the host agy catalog again and leaves Orca's homes fresh", async () => {
  const host = await accounts()
  agy.set('host', host.service)
  const [hostAgy] = antigravityHostCatalogFingerprints()
  saveCatalog(hostAgy!)
  saveCatalog('orca-home')
  if ('stream' in select) {
    throw new Error('select streams')
  }
  await select.handler({ target: { runtime: 'host' }, accountId: host.b }, context)
  expect([store.shouldRefresh(hostAgy!), store.shouldRefresh('orca-home')]).toEqual([true, false])
})

it("selecting a WSL distro's account reads its agy login only as the switch needs", async () => {
  const wsl = await accounts()
  agy.set('wsl', wsl.service)
  vi.mocked(wsl.backend.read).mockClear()
  if ('stream' in select) {
    throw new Error('select streams')
  }
  await select.handler(
    { target: { runtime: 'wsl', wslDistro: 'Ubuntu' }, accountId: wsl.b },
    context
  )
  expect(vi.mocked(wsl.backend.read).mock.calls.length).toBe(2)
})

it('a switch lists again a catalog under a launch HOME sharing the login, not one with its own file', async () => {
  const host = await accounts()
  agy.set('host', host.service)
  const shellHome = agentModelCatalogFingerprint({
    agent: 'antigravity',
    accountHome: antigravityHostAccountHome('/Users/shell-home'),
    wslDistro: null
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: select reads only the settings from the runtime's store.
  const runtime = {
    requireStore: () => ({ getSettings: () => ({}) })
  } as unknown as RpcContext['runtime']
  if ('stream' in select) {
    throw new Error('select streams')
  }
  saveCatalog(shellHome)
  login.shared = false
  await select.handler({ target: { runtime: 'host' }, accountId: host.b }, { ...context, runtime })
  expect(store.shouldRefresh(shellHome)).toBe(false)
  login.shared = true
  await select.handler({ target: { runtime: 'host' }, accountId: host.a }, { ...context, runtime })
  expect(store.shouldRefresh(shellHome)).toBe(true)
})

it('a switch never waits for the launch environment, and still lists its HOME again once known', async () => {
  const host = await accounts()
  agy.set('host', host.service)
  const shellHome = agentModelCatalogFingerprint({
    agent: 'antigravity',
    accountHome: antigravityHostAccountHome('/Users/shell-home'),
    wslDistro: null
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: select reads only the settings from the runtime's store.
  const runtime = {
    requireStore: () => ({ getSettings: () => ({}) })
  } as unknown as RpcContext['runtime']
  if ('stream' in select) {
    throw new Error('select streams')
  }
  saveCatalog(shellHome)
  vi.mocked(host.backend.read).mockClear()
  const held = Promise.withResolvers<NodeJS.ProcessEnv>()
  login.env = held.promise
  const selecting = select.handler(
    { target: { runtime: 'host' }, accountId: host.b },
    { ...context, runtime }
  )
  // Switched, reading agy's login only as the switch itself does.
  await vi.waitFor(() => expect(host.getNative()).toBe(credential('b')))
  expect(vi.mocked(host.backend.read).mock.calls.length).toBe(2)
  expect(store.shouldRefresh(shellHome)).toBe(false)
  held.resolve({ HOME: '/Users/shell-home' })
  await selecting
  expect(store.shouldRefresh(shellHome)).toBe(true)
})

it('a switch leaves a launch HOME with its own credential file alone, its listing still running', async () => {
  const host = await accounts()
  agy.set('host', host.service)
  const fileHome = agentModelCatalogFingerprint({
    agent: 'antigravity',
    accountHome: antigravityHostAccountHome('/Users/file-home'),
    wslDistro: null
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: select reads only the settings from the runtime's store.
  const runtime = {
    requireStore: () => ({ getSettings: () => ({}) })
  } as unknown as RpcContext['runtime']
  if ('stream' in select) {
    throw new Error('select streams')
  }
  saveCatalog(fileHome)
  store.relistScope(fileHome)
  void store.refresh(fileHome, 'antigravity', () => new Promise(() => {}))
  login.shared = true
  login.env = Promise.resolve({ HOME: '/Users/file-home', SSH_TTY: '/dev/ttys001' })
  await select.handler({ target: { runtime: 'host' }, accountId: host.b }, { ...context, runtime })
  expect(store.isListing(fileHome)).toBe(true)
  expect(store.get(fileHome)?.seen?.models.map((model) => model.id)).toEqual(['gemini-4-neon-high'])
})

it("a Refresh started after a switch lists the new account, even as the launch HOME's check lands", async () => {
  const host = await accounts()
  agy.set('host', host.service)
  const shellHome = agentModelCatalogFingerprint({
    agent: 'antigravity',
    accountHome: antigravityHostAccountHome('/Users/shell-home'),
    wslDistro: null
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: select reads only the settings from the runtime's store.
  const runtime = {
    requireStore: () => ({ getSettings: () => ({}) })
  } as unknown as RpcContext['runtime']
  if ('stream' in select) {
    throw new Error('select streams')
  }
  saveCatalog(shellHome)
  login.env = Promise.resolve({ HOME: '/Users/shell-home' })
  const check = Promise.withResolvers<boolean>()
  login.launchStore = check.promise
  await select.handler({ target: { runtime: 'host' }, accountId: host.b }, { ...context, runtime })
  const b = parseAgyModelListing('gemini-5-b-high\tGemini 5 B (high)')
  const listed = Promise.withResolvers<{ models: typeof b; origin: 'probe' }>()
  let probes = 0
  store.relistScope(shellHome)
  const refresh = store.refresh(shellHome, 'antigravity', () => {
    probes += 1
    return listed.promise
  })
  check.resolve(false)
  await vi.waitFor(() => expect(store.get(shellHome)?.seen).toBeUndefined())
  listed.resolve({ models: b, origin: 'probe' })
  await refresh
  login.launchStore = undefined
  expect(store.get(shellHome)?.models.map((model) => model.id)).toEqual(['gemini-5-b-high'])
  expect(probes).toBe(1)
})
