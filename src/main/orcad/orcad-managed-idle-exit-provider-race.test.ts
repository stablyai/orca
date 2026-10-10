import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-idle-exit'
import { bindOrcadIdleShutdown, beginOrcadIdleExit } from './orcad-managed-idle-exit-host'
import { installOrcadManagedIdleExit } from './orcad-managed-idle-exit'
import type * as ManagedIdleExit from './orcad-managed-idle-exit'
import { retireOrcadDaemonIfIdle } from './orcad-daemon-retirement'
import { discardOrcadIdleStopRecord } from './orcad-idle-stop-record'

const { hasLoadedProviders } = vi.hoisted(() => ({ hasLoadedProviders: vi.fn(() => false) }))

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ hasLoadedProviders })
}))
vi.mock('../ipc/pty', () => ({ getLocalPtyProvider: () => ({ listProcesses: async () => [] }) }))
vi.mock('../daemon/daemon-init', () => ({ getDaemonEndpointFacts: () => null }))
vi.mock('./orcad-daemon-retirement', () => ({
  countLiveOrcadDaemonSessions: vi.fn(async () => 0),
  retireOrcadDaemonIfIdle: vi.fn()
}))
vi.mock('./orcad-idle-stop-record', () => ({
  consumeOrcadIdleStopRecord: vi.fn(() => null),
  discardOrcadIdleStopRecord: vi.fn(),
  writeOrcadIdleStopRecord: vi.fn()
}))
vi.mock('./orcad-managed-idle-exit', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedIdleExit>()),
  installOrcadManagedIdleExit: vi.fn(() => () => {})
}))

beforeEach(() => {
  vi.clearAllMocks()
  hasLoadedProviders.mockReturnValue(false)
  vi.stubEnv(ORCAD_MANAGED_ACTIVATION_ROOT_ENV, 'test-fence')
})

afterEach(() => vi.unstubAllEnvs())

it.each(['provider', 'client', 'request', 'recent request'])(
  'rechecks a returning %s after daemon retirement before requesting an idle shutdown',
  async (returning) => {
    const activity = { openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }
    const retire = Promise.withResolvers<{ retirement: string; reason: null }>()
    vi.mocked(retireOrcadDaemonIfIdle).mockImplementationOnce(async () => ({
      ...(await retire.promise),
      retirement: 'retired',
      liveSessions: 0
    }))
    const shutdown = vi.fn(() => true)
    bindOrcadIdleShutdown(shutdown)
    await beginOrcadIdleExit('test-profile').start({
      rpc: {
        readClientActivity: () => activity
      },
      agentStates: () => [],
      hasStagedMigration: () => false,
      automationsBusy: () => false,
      registerCleanup: () => {}
    })
    const installed = vi.mocked(installOrcadManagedIdleExit).mock.calls.at(-1)?.[0]
    if (!installed) {
      throw new Error('idle monitor was not installed')
    }
    const stopping = installed.stop({ quietSince: 0, stoppedAt: 900_000, timeoutMs: 900_000 })
    hasLoadedProviders.mockReturnValue(returning === 'provider')
    activity.openConnections = returning === 'client' ? 1 : 0
    activity.requestsInFlight = returning === 'request' ? 1 : 0
    activity.lastRequestAt = returning === 'recent request' ? 1 : 0
    retire.resolve({ retirement: 'retired', reason: null })

    expect(await stopping).toBe(false)
    expect(shutdown).not.toHaveBeenCalled()
    expect(discardOrcadIdleStopRecord).toHaveBeenCalledWith('test-profile')
  }
)
