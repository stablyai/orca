import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import type { RuntimeClientEvent } from '../../shared/remote-runtime/session-graph/runtime-client-events'
import { makeTestBot } from '../bots/bot.test-fixture'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ConnectorCloud } from './connector-cloud'
import { installConnectorHost } from './connector-host-install'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeSeam } from './fake-connector-seam.test-fixture'

// mintedFrom: the data folder each token mint read its account and install id from.
const cloud = vi.hoisted((): { fake: FakeConnectorCloud | null; mintedFrom: string[] } => ({
  fake: null,
  mintedFrom: []
}))
vi.mock('../orca-profiles/cloud-auth/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: true, config: {} })
}))
vi.mock('./connector-origin', () => ({ resolveConnectorOrigin: () => cloud.fake!.origin }))
vi.mock('./connector-token-mint', () => ({
  connectorAccount: () => 'ada',
  desktopConnectorTokenMint: (_config: unknown, userDataPath: string, account: string) => {
    cloud.mintedFrom.push(userDataPath)
    return cloud.fake!.mintFor(account)
  }
}))
// Host work with its own tests; here only that the installer starts it.
const started = vi.hoisted(() => ({ webhooks: 0, accessWatch: 0 }))
vi.mock('../webhooks/webhook-host-service', () => ({
  WebhookHostService: class {
    start = async () => {
      started.webhooks++
    }
    changed = () => {}
    stop = () => {}
    pausing = () => false
    onConfirmed = () => {}
    helloAnswered = () => {}
  }
}))
vi.mock('../bots/bot-access-request-watch', () => ({
  botAccessSeenFile: () => '',
  createBotAccessRequestWatch: () => ({
    start: () => {
      started.accessWatch++
      return () => {}
    }
  })
}))
vi.mock('../bots/bot-access-host', () => ({ botAccessHost: () => ({}) }))
vi.mock('../runtime/rpc/methods/bots-composio-upkeep', () => ({
  installComposioUpkeep: () => ({ soon: () => {} })
}))
vi.mock('./bot-avatar-sync', () => ({
  BotAvatarSync: class {
    changed = () => {}
  }
}))
vi.mock('../bots/bot-pr-events', () => ({
  BotPrWaker: class {
    resume = () => {}
  }
}))
vi.mock('../linear/accounts/linear-login-refresh', () => ({
  refreshDueLinearLogins: async () => {}
}))

function fakeHost() {
  const seam = fakeSeam()
  const bot = makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })
  let connector: ConnectorCloud | null = null
  const listeners: ((event: RuntimeClientEvent) => void)[] = []
  const host: { webhooks: unknown; runtime: OrcaRuntimeService; store: Store } = {
    webhooks: null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer reads only these runtime members; the host work it starts is mocked above.
    runtime: {
      setConnectorCloud: (next: ConnectorCloud | null) => {
        connector = next
      },
      getConnectorCloud: () => connector,
      setWebhooks: (webhooks: unknown) => {
        host.webhooks = webhooks
      },
      onClientEvent: (listener: (event: RuntimeClientEvent) => void) => listeners.push(listener),
      getExternalConversationSeam: () => seam.seam,
      notifyBotsChanged: () => {},
      readMachineName: () => 'Studio Mac',
      machineNameReady: async () => {},
      onBotsWritten: () => () => {},
      bots: { enabled: () => true },
      botWork: {}
    } as unknown as OrcaRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the connector reads bots, automations and settings only.
    store: {
      getBots: () => [bot],
      getFolderWorkspaces: () => [],
      listAutomations: () => [],
      listAutomationRuns: () => [],
      getSettings: () => ({ botsEnabled: true }),
      onSettingsChanged: () => () => {}
    } as unknown as Store
  }
  return host
}

beforeEach(() => {
  vi.useFakeTimers()
  cloud.fake = new FakeConnectorCloud()
  cloud.mintedFrom = []
  started.webhooks = 0
  started.accessWatch = 0
  vi.stubGlobal('fetch', cloud.fake.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('installConnectorHost', () => {
  it.each(['desktop', 'serve'] as const)(
    'on a %s host: says hello as that runtime, as its own account, and starts the host work',
    async (kind) => {
      const host = fakeHost()
      const userDataPath = `/data/${kind}`

      installConnectorHost({
        runtime: host.runtime,
        store: host.store,
        userDataPath,
        kind,
        isFenced: () => false
      })
      host.runtime.getConnectorCloud()!.connect()
      await vi.advanceTimersByTimeAsync(10)

      const [hello] = cloud.fake!.requestsTo(CONNECTOR_PATHS.hello)
      const said = z.object({ runtime: z.string(), hostName: z.string() }).parse(hello?.body)
      expect(said.runtime).toBe(kind)
      // The computer's display name, never os.hostname() (e.g. "MacBook-Pro-5.localdomain").
      expect(said.hostName).toBe('Studio Mac')
      expect(new Set(cloud.mintedFrom)).toEqual(new Set([userDataPath]))
      expect(host.webhooks).not.toBeNull()
      expect(started).toEqual({ webhooks: 1, accessWatch: 1 })
    }
  )

  it('stops a fenced host before anything new reaches Orca Cloud', async () => {
    const host = fakeHost()
    let stopping = false
    installConnectorHost({
      runtime: host.runtime,
      store: host.store,
      userDataPath: '/data/serve',
      kind: 'serve',
      isFenced: () => stopping
    })
    stopping = true
    host.runtime.getConnectorCloud()!.fence()
    host.runtime.getConnectorCloud()!.connect()
    await vi.advanceTimersByTimeAsync(10)

    expect(cloud.fake!.requests).toHaveLength(0)
    expect(host.runtime.getConnectorCloud()!.status()).toBe('signed-out')
  })
})
