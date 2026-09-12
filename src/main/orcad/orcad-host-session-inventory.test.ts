import { beforeEach, expect, it, vi } from 'vitest'
import { collectOrcadTerminalCensus } from './orcad-terminal-census'
import { listLiveDaemonSessions } from '../daemon/daemon-init'
import type { snapshotDelegatedPtyProviderRoutes } from '../ipc/pty/provider/delegated-provider-routes'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

type Route = ReturnType<typeof snapshotDelegatedPtyProviderRoutes>[number]
const state = vi.hoisted(() => ({
  revision: 0,
  routes: [] as Route[],
  reserved: new Set<string>()
}))
vi.mock('../daemon/daemon-init', () => ({ listLiveDaemonSessions: vi.fn() }))
vi.mock('../ipc/pty/provider/delegated-provider-routes', () => ({
  delegatedPtyProviderRoutesRevision: () => state.revision,
  snapshotDelegatedPtyProviderRoutes: () => state.routes,
  hasDelegatedPtyProviderRoute: (id: string) => state.reserved.has(id)
}))
beforeEach(() => {
  vi.resetAllMocks()
  state.revision = 0
  state.routes = []
  state.reserved.clear()
  vi.mocked(listLiveDaemonSessions).mockResolvedValue([])
})
const row = { id: identity.terminalId, incarnationId: identity.incarnationId, createdAt: 1 }
function delegated(sessions = [row]) {
  const listProcesses = vi.fn(async () => sessions)
  const route: Route = { identity, isCurrent: () => true, provider: { listProcesses } as never }
  state.routes.push(route)
  state.reserved.add(identity.terminalId)
  return { route, listProcesses }
}

it('includes delegated terminals but never substitutes source birth for transfer admission time', async () => {
  delegated()
  vi.mocked(listLiveDaemonSessions).mockResolvedValue([
    { sessionId: 'native', createdAt: 3_000 },
    { sessionId: identity.terminalId, createdAt: 1 }
  ] as never)
  await expect(collectOrcadTerminalCensus(2_000)).resolves.toEqual({
    liveSessions: 2,
    startedSinceActivation: null
  })
})

it('excludes retired native duplicates without counting tombstones as live', async () => {
  state.reserved.add(identity.terminalId)
  vi.mocked(listLiveDaemonSessions).mockResolvedValue([
    { sessionId: row.id, createdAt: 1 }
  ] as never)
  await expect(collectOrcadTerminalCensus(2_000)).resolves.toEqual({
    liveSessions: 0,
    startedSinceActivation: 0
  })
})

it.each([
  'unbound',
  'failed',
  'wrong-incarnation',
  'changed-route',
  'changed-coverage',
  'native-missing'
])('keeps rollback coverage unverifiable when %s', async (mode) => {
  const { route, listProcesses } = delegated()
  if (mode === 'unbound') {
    route.provider = undefined
  }
  if (mode === 'failed') {
    listProcesses.mockRejectedValue(new Error('source disconnected'))
  }
  if (mode === 'wrong-incarnation') {
    listProcesses.mockResolvedValue([{ ...row, incarnationId: 'other' }])
  }
  if (mode === 'changed-route') {
    listProcesses.mockImplementation(async () => {
      route.isCurrent = () => false
      return [row]
    })
  }
  if (mode === 'changed-coverage') {
    listProcesses.mockImplementation(async () => {
      state.revision++
      return [row]
    })
  }
  if (mode === 'native-missing') {
    vi.mocked(listLiveDaemonSessions).mockResolvedValue(null)
  }
  await expect(collectOrcadTerminalCensus(2_000)).resolves.toEqual({
    liveSessions: null,
    startedSinceActivation: null
  })
})

it('preserves known native-only activation counts', async () => {
  vi.mocked(listLiveDaemonSessions).mockResolvedValue([
    { sessionId: 'native', createdAt: 3_000 }
  ] as never)
  await expect(collectOrcadTerminalCensus(2_000)).resolves.toEqual({
    liveSessions: 1,
    startedSinceActivation: 1
  })
})
