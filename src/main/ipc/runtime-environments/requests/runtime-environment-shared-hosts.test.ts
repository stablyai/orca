// A shared agent's host is reached as a paired server: its id resolves from the share (never the
// store), the paired path signs in with the share's device key, over Relay on its one link, and the
// share keeps the Relay credential the host installs. A real host behind a stand-in Relay cell.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, expect, it, vi } from 'vitest'
import type * as NodeRelayPlatform from '../../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import {
  setSharedHosts,
  sharedHostEnvironment
} from '../../../../shared/remote-runtime/pairing/shared-host-keys'
import { parseRuntimeRelayEndpoint } from '../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import { SharedBotHosts } from '../../../bots/shared-with-me/shared-bot-hosts'
import { keptSharedHostRegistry } from '../../../bots/shared-with-me/shared-bot-host-key'
import {
  RELAY_TEST_INVITE,
  startHostOverRelay
} from '../../../runtime/rpc/testing/relay-runtime-host.test-fixtures'
import {
  closeRemoteRuntimeRequestConnection,
  getRemoteRuntimeSharedControlDiagnostics,
  getRuntimeEnvironmentStatusSnapshot
} from '../connections/runtime-environment-request-connections'
import { controlLinkOptions } from '../connections/runtime-environment-relay-link'
import { setSharedHostsOwner } from './runtime-environment-shared-hosts'
import { getPreferredPairedRuntimeConnection } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { runtimeHostStatusBlockedReason } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { SHARED_BOT_HOST_ERRORS } from '../../../../shared/bots/shared-bot-hosts'
import type { MineShare } from '../../../bots/shared-with-me/shared-bot-pairing'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Bot } from '../../../../shared/bot-types'

// The network edge: main's Relay dials reach the stand-in cell, as the fixture's own client does.
const cell = vi.hoisted((): { url: string; dialed: string[] } => ({ url: '', dialed: [] }))
vi.mock(
  '../../../../shared/remote-runtime/relay/client/node/node-relay-client-platform',
  async (actual) => {
    const real = (await actual<typeof NodeRelayPlatform>()).NODE_RELAY_CLIENT_PLATFORM
    return {
      NODE_RELAY_CLIENT_PLATFORM: {
        ...real,
        createSocket: (url: string, events: Parameters<typeof real.createSocket>[1]) => {
          cell.dialed.push(new URL(url).host)
          return real.createSocket(url.replace(/^wss:\/\/[^/]+/, cell.url), events)
        }
      }
    }
  }
)

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  setSharedHosts(null)
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

const ENVIRONMENT_ID = 'env-shared-1'

const CHANNEL_EVENTS = {
  onTransportOpen: () => {},
  onAuthenticating: () => {},
  onAuthenticated: () => {},
  onAnswer: () => {},
  onText: () => {},
  onBinary: () => {},
  onClosed: () => {}
}
const failure = (code: string) => ({
  id: 'status.get',
  ok: false as const,
  error: { code, message: code }
})

it(
  'answers a call by the share’s id, signed in with its device key, and keeps the host’s Relay credential with the share',
  async () => {
    let shareDeviceId = ''
    // The host shares its agent with this teammate's account.
    const runtime = new OrcaRuntimeService()
    const bot = {
      id: 'bot-1',
      shares: [{ kind: 'account', accountId: 'acct-teammate', shareId: 'share-1', addedAt: 1 }]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the share checks read only a bot's id and shares.
    vi.spyOn(runtime.bots, 'list').mockImplementation(() => [bot] as unknown as Bot[])
    const host = await startHostOverRelay(cleanups, {
      relayDeviceId: () => shareDeviceId,
      runtime
    })
    cell.url = host.cell.url
    // The cell admits only dials to the cell the director names; main's dials are recorded here.
    host.cellState.dialedHosts = cell.dialed
    // This device's key on the host, as accepting a share gives it.
    const key = nacl.sign.keyPair()
    const shareDevice = await host.server.getBotShareDevices()!.add({
      botId: 'bot-1',
      accountId: 'acct-teammate',
      scope: 'runtime',
      devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64')
    })
    shareDeviceId = shareDevice.deviceId
    const userDataPath = mkdtempSync(join(tmpdir(), 'shared-host-paired-'))
    cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    // The account's share list: this share, until the owner stops sharing it.
    let mine: MineShare[] = [
      {
        shareId: 'share-1',
        botId: 'bot-1',
        botName: 'Ivy',
        ownerName: 'Jinwoo Hong',
        hostOnline: true,
        state: 'ready',
        held: []
      }
    ]
    const hosts = new SharedBotHosts({
      userDataPath,
      account: () => 'ada',
      cloud: () => ({
        mine: async () => ({ ok: true, value: { v: 1, shares: mine } }),
        accept: async () => ({ ok: true, value: { status: 'queued' } }),
        decline: async () => ({ ok: true, value: { status: 'declined' } }),
        hold: async () => ({ ok: true, value: { status: 'held' } })
      }),
      publish: () => {}
    })
    await hosts.ready()
    const reach = parseRuntimeRelayEndpoint(host.connection.endpoint)!
    hosts.store.put({
      shareId: 'share-1',
      environmentId: ENVIRONMENT_ID,
      botId: 'bot-1',
      botName: 'Ivy',
      ownerName: 'Jinwoo Hong',
      deviceKey: {
        publicKeyB64: Buffer.from(key.publicKey).toString('base64'),
        secretKeyB64: Buffer.from(key.secretKey).toString('base64')
      },
      sealKey: { publicKeyB64: 's', secretKeyB64: 's' },
      offer: {
        v: 1,
        relay: {
          v: 1,
          directorUrl: 'https://relay.test',
          cellUrl: reach.cellUrl,
          assignmentEpoch: 1,
          relayHostId: reach.relayHostId,
          e2eeFraming: 2,
          inviteToken: RELAY_TEST_INVITE,
          inviteExpiresAt: reach.inviteExpiresAt
        },
        hostPublicKeyB64: host.connection.hostPublicKeyB64,
        deviceId: shareDevice.deviceId,
        botId: 'bot-1'
      },
      held: [],
      phones: []
    })
    setSharedHosts(
      keptSharedHostRegistry(
        hosts.store,
        () => hosts.listed(),
        () => hosts.ready()
      )
    )
    setSharedHostsOwner(hosts)
    cleanups.push(() => setSharedHostsOwner(null))
    cleanups.push(() => closeRemoteRuntimeRequestConnection(ENVIRONMENT_ID))

    // Its first call opens the host's link (nothing else has yet), and the host answers it.
    await expect(
      callRuntimeEnvironment(userDataPath, ENVIRONMENT_ID, 'terminal.send', {})
    ).resolves.toMatchObject({ id: expect.any(String) })
    const status = await callRuntimeEnvironment(userDataPath, ENVIRONMENT_ID, 'status.get', {})
    expect(status).toMatchObject({ ok: true })
    // Its environment names the runtime that answered, as a paired server's does: the window's tab
    // streams are fenced on it.
    expect(sharedHostEnvironment(ENVIRONMENT_ID)?.runtimeId).toBe(runtime.getRuntimeId())
    // It works in the agent's workspaces, so the host admits the list of the agent's home (this
    // stand-in host has no folder lists, so the call gets past the teammate gate to the lookup).
    await expect(
      callRuntimeEnvironment(userDataPath, ENVIRONMENT_ID, 'folderWorkspace.list', {})
    ).resolves.toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    // Listed with no paired server's, its status is marked as a shared host's, so the window keeps it.
    expect(getRuntimeEnvironmentStatusSnapshot(ENVIRONMENT_ID)?.sharedHost).toBe(true)
    // The share, not the endpoint's first invite, holds the credential the host installed.
    const kept = hosts.store.get('share-1')!
    expect(kept.resume?.token).toBeTruthy()
    expect(kept.refusedInvite).toBe(RELAY_TEST_INVITE)
    expect(kept).toMatchObject({ botName: 'Ivy', deviceKey: { publicKeyB64: expect.any(String) } })
    expect(host.cell.credentials).toEqual([RELAY_TEST_INVITE])
    // The share's link reads the host's paired connection: live, then away once it drops.
    expect(hosts.views()[0]?.link).toBe('live')
    host.cellState.hostOffline = true
    host.cell.cut()
    await vi.waitFor(() => expect(hosts.views()[0]?.link).toBe('offline'), { timeout: 10_000 })
    // Its connection redials on its own; the host is still away, so the link stays away meanwhile.
    const dials = cell.dialed.length
    const seen: string[] = []
    await vi.waitFor(
      () => {
        seen.push(hosts.views()[0]!.link)
        expect(cell.dialed.length).toBeGreaterThan(dials)
      },
      { timeout: 10_000, interval: 5 }
    )
    expect(new Set(seen)).toEqual(new Set(['offline']))
    // The host is back: an asked-for dial (a phone's key, the cloud saying it is online) is awaited,
    // not answered from the away state, and a second ask joins it rather than reopening it.
    host.cellState.hostOffline = false
    const link = hosts['linkFor'](hosts.store.get('share-1')!)
    const [first, second] = await Promise.all([link.connect(), link.connect()])
    expect([first, second]).toEqual(['live', 'live'])
    expect(link.current()).toBe('live')

    // The owner stops sharing it: nothing of it stays open or redials, and a call answers as ended.
    const paired = getPreferredPairedRuntimeConnection(sharedHostEnvironment(ENVIRONMENT_ID)!)
    mine = []
    await hosts.refresh()
    expect(getRuntimeEnvironmentStatusSnapshot(ENVIRONMENT_ID)).toBeNull()
    expect(getRemoteRuntimeSharedControlDiagnostics(ENVIRONMENT_ID)).toBeNull()
    expect(
      await callRuntimeEnvironment(userDataPath, ENVIRONMENT_ID, 'status.get', {})
    ).toMatchObject({ ok: false, error: { code: SHARED_BOT_HOST_ERRORS.unshared } })
    // A connection opened with its old key finds no Relay credential to dial, and stops there.
    const opened = controlLinkOptions(ENVIRONMENT_ID, paired).openChannel!([])(CHANNEL_EVENTS)
    expect(opened).toMatchObject({ ok: false, error: { code: 'relay_credential_unavailable' } })
    expect(runtimeHostStatusBlockedReason(failure('relay_credential_unavailable'))).toBe(
      'access-revoked'
    )
    // Nothing of it was written to the paired-server store.
    await expect(
      callRuntimeEnvironment(userDataPath, 'env-never-shared', 'status.get', {})
    ).rejects.toThrow('Unknown environment')
    hosts.stop()
  },
  // A real host and cell: a few dials over loopback.
  30_000
)
