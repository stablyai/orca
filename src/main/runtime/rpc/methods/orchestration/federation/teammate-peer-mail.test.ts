// A teammate's computer and the computer that shares an agent with them, mailing each other's bots as
// paired computers do. The teammate's side lists and resolves the shared host through its real
// transport; each call reaches the host's dispatcher as the share's device, so the host admits it by
// the teammate rules a live share link stamps.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_TEAMMATE_PEER_MAIL_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { BOTS_SHARE_WORKSPACES_CAPABILITY } from '../../../../../../shared/bot-runtime-capabilities'
import { setAppEnvironment } from '../../../../../../shared/app-lifecycle/app-environment'
import {
  setSharedHosts,
  sharedHostsReady,
  type SharedHost
} from '../../../../../../shared/remote-runtime/pairing/shared-host-keys'
import nacl from 'tweetnacl'
import { OrcaRuntimeRpcServer } from '../../../server/runtime-rpc'
import type { RuntimeRpcResponse } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { createOrchestrationEnvironmentTransport } from '../../../../../ipc/runtime-environments/requests/orchestration-environment-transport'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { listeningClients } from '../../../../orchestration/federation/client-asks/client-ask-listeners'
import {
  allowServer,
  isServerAllowed
} from '../../../../orchestration/db/federation/paired-server-asks-store'
import {
  botShareCallerScopeOf,
  botSharePrincipalOf
} from '../../../server/pairing/device-principal'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { ORCHESTRATION_REPLY_METHOD } from '../messaging/reply-method'
import { PAIRED_SERVER_ASKS_METHODS } from '../../paired-server-asks/paired-server-asks-methods'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import { turnActsForOwner } from '../../../../../bots/bot-request-asker'
import type * as RecipientRouting from '../messaging/recipient-routing'
import type * as SharedHostKeys from '../../../../../../shared/remote-runtime/pairing/shared-host-keys'
import {
  DOCS_CHAT,
  journals,
  RANGER_CHAT,
  RANGER_THREAD,
  withChat
} from '../messaging/bot-recipient.test-fixture'
import { runningTurnItems } from './sending-bot-turn.test-fixture'

vi.mock(
  '../../../../orchestration/federation/relay/federation-relay-scheduler',
  async (original) => ({
    ...(await original<object>()),
    federationRelayRetryDelayMs: () => 0
  })
)
// The one gate every reader of shared hosts passes, watched so a test can see a reader wait on it.
vi.mock('../../../../../../shared/remote-runtime/pairing/shared-host-keys', async (original) => {
  const actual = await original<typeof SharedHostKeys>()
  return { ...actual, sharedHostsReady: vi.fn(actual.sharedHostsReady) }
})
vi.mock('../../../../hosts/platform-probe/host-descriptor', async (original) => ({
  ...(await original<object>()),
  getPublishedHostDescriptor: () => ({ installationId: 'install_dana' })
}))
vi.mock(
  '../../../../../bots/bot-session-tabs',
  async () => (await import('../messaging/bot-recipient.test-fixture')).botSessionTabsMock
)
vi.mock(
  '../../../../../bots/bot-chat-session',
  async () => (await import('../messaging/bot-recipient.test-fixture')).botChatSessionMock
)
vi.mock(
  '../../../../../bots/bot-chat-mail-hold',
  async () => (await import('../messaging/bot-recipient.test-fixture')).botChatMailHoldMock
)
vi.mock(
  '../../../../../bots/bot-chat-status-line',
  async () => (await import('../messaging/bot-recipient.test-fixture')).botChatStatusLineMock
)
vi.mock('../messaging/recipient-routing', async (importOriginal) =>
  (await import('../messaging/bot-recipient.test-fixture')).recipientRoutingMock(
    await importOriginal<typeof RecipientRouting>()
  )
)

const DANA = 'acct-dana'
const SHARED_ENVIRONMENT = 'env-shared-ranger'
// On the owner's computer: Ranger's chat that asks, and Dana's Home of Ranger.
const RANGER_ASKS = `orca_session_id:${RANGER_THREAD}`
const DANA_HOME_OF_RANGER = `orca_session_id:${RANGER_CHAT}`
// An agent on the owner's computer that no share names.
const OTHER_AGENT = 'orca_session_id:55555555-5555-4555-8555-555555555555'
// On Dana's computer: her own bot's Home.
const DOCS_HOME = `orca_session_id:${DOCS_CHAT}`
const DANA_AS_MEMBER = {
  kind: 'person',
  source: 'orca',
  userId: DANA,
  name: 'Dana',
  workspaceId: null,
  role: 'member'
}
// Dana typed in her own bot's chat on her own computer, so her Orca carries her as its owner.
const DANA_TYPED = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ask Ranger for a build' }],
  typedBy: { by: 'host' }
}

const BUILDER_ENVIRONMENT = 'env-shared-builder'
// The same computer shares two agents with Dana: two shares, one host key.
const HOST_KEY = Buffer.alloc(32, 7).toString('base64')

function share(botId: string, deviceId: string, name: string) {
  const device = {
    deviceId,
    botId,
    accountId: DANA,
    scope: 'runtime' as const,
    devicePublicKeyB64: `${deviceId}-key`,
    pairedAt: 1
  }
  // The share as Dana's Orca keeps it: the host's Relay reach and key, and her device there.
  const host: SharedHost = {
    name,
    offer: {
      relay: {
        v: 1,
        directorUrl: 'https://relay.test',
        cellUrl: 'https://cell.relay.test',
        assignmentEpoch: 1,
        relayHostId: 'relay-host-owner',
        inviteToken: 'invite',
        inviteExpiresAt: 1,
        e2eeFraming: 2
      },
      hostPublicKeyB64: HOST_KEY,
      deviceId
    },
    credential: { kind: 'device-key', deviceId, sign: async () => new Uint8Array(64) },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transport never dials here; calls go to the host's dispatcher.
    relay: {} as SharedHost['relay']
  }
  return { device, host }
}

const SHARES: Record<string, ReturnType<typeof share>> = {
  [SHARED_ENVIRONMENT]: share('ranger', 'share-device-dana', 'Ranger'),
  [BUILDER_ENVIRONMENT]: share('builder', 'share-device-dana-2', 'Builder')
}

const shareOf = (accountId: string, shareId: string) => ({
  kind: 'account' as const,
  accountId,
  name: 'Dana',
  email: 'dana@example.com',
  shareId,
  addedAt: 1
})

type Side = { db: OrchestrationDb; runtime: OrcaRuntimeService }

function sessionCaller(address: string): OrchestrationSessionCaller {
  const id = address.slice('orca_session_id:'.length)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
  return {
    address,
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: id,
    sessionId: id,
    workspaceId: 'w'
  } as OrchestrationSessionCaller
}

const send = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.send')!

describe("a teammate's bots and the agent shared with them", () => {
  let dir: string
  let owner: Side
  let dana: Side
  // What the owner's Orca says it can do; an older build lacks the teammate capability.
  let ownerCapabilities: (capabilities: string[]) => string[]
  // Dana's kept shares: which are kept, and whether they are loaded yet (a restart reads them late).
  let kept: string[]
  let loaded: boolean
  let sharesLoaded: Promise<void>
  let shareReads: number
  // The owner's RPC server, once a test needs its share devices; a device it no longer keeps is refused.
  let ownerServer: OrcaRuntimeRpcServer | null

  function openSide(
    name: string,
    machine: string,
    bots: ReturnType<typeof makeTestBot>[],
    transport?: ConstructorParameters<typeof OrcaRuntimeService>[2]
  ): Side {
    const db = new OrchestrationDb(join(dir, `${name}.db`))
    const runtime = new OrcaRuntimeService(null, undefined, transport)
    vi.spyOn(runtime, 'readMachineName').mockReturnValue(machine)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    vi.spyOn(runtime.bots, 'list').mockReturnValue(bots)
    vi.spyOn(runtime.bots, 'enabled').mockReturnValue(true)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue([])
    runtime.setOrchestrationDb(db)
    return { db, runtime }
  }

  /** Every call from Dana's Orca, as the owner's computer admits its share's device. */
  async function callOwner(
    selector: string,
    method: string,
    rawParams: unknown
  ): Promise<RuntimeRpcResponse<unknown>> {
    const shareDevice = SHARES[selector]!.device
    if (ownerServer && !ownerServer.getBotShareDevices()?.get(shareDevice.deviceId)) {
      return { id: method, ok: false, error: { code: 'unauthorized', message: 'Not shared' } }
    }
    const params = { ...z.record(z.string(), z.unknown()).parse(rawParams ?? {}) }
    if (method === 'orchestration.peerMailPull') {
      // Short waits, so a test sees the loop's next pull.
      params.waitMs = Math.min(Number(params.waitMs ?? 0), 100)
    }
    if (method === 'status.get') {
      const status = owner.runtime.getStatus()
      return {
        id: 'status',
        ok: true,
        result: {
          ...status,
          capabilities: ownerCapabilities(status.capabilities ?? []),
          hostDescriptor: { installationId: 'install_owner' }
        },
        _meta: { runtimeId: owner.runtime.getRuntimeId() }
      }
    }
    const principal = botSharePrincipalOf(shareDevice)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dispatcher's answer is the envelope the transport returns.
    return (await new RpcDispatcher({
      runtime: owner.runtime,
      methods: ORCHESTRATION_METHODS
    }).dispatch(
      {
        id: `from_dana_${method}`,
        authToken: '',
        method,
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
      },
      {
        authenticatedCallerFingerprint: principal.callerFingerprint,
        clientId: principal.clientId,
        pairedDeviceId: shareDevice.deviceId,
        clientKind: 'runtime',
        callerScope: botShareCallerScopeOf(shareDevice, [BOTS_SHARE_WORKSPACES_CAPABILITY])
      }
    )) as RuntimeRpcResponse<unknown>
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-teammate-peer-mail-'))
    ownerCapabilities = (capabilities) => capabilities
    setAppEnvironment({
      getPath: () => join(dir, 'dana-user-data'),
      getAppPath: () => dir,
      getVersion: () => '0.0.0',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    kept = [SHARED_ENVIRONMENT]
    SHARES[SHARED_ENVIRONMENT] = share('ranger', 'share-device-dana', 'Ranger')
    sharesLoaded = Promise.resolve()
    loaded = true
    shareReads = 0
    ownerServer = null
    registerKeptShares()
    withChat.mockReset()
    // Each person's Home of Ranger: the owner's and Dana's.
    withChat.mockImplementation((botId, of, work) =>
      work(botId === 'ranger' ? (of === 'owner' ? 'owner-home' : RANGER_CHAT) : DOCS_CHAT)
    )
    journals[DOCS_CHAT] = runningTurnItems(DANA_TYPED)
    owner = openSide("Jinwoo's MacBook", "Jinwoo's MacBook", [
      makeTestBot({
        id: 'ranger',
        name: 'Ranger',
        shares: [shareOf(DANA, 'share-1')]
      }),
      makeTestBot({ id: 'builder', name: 'Builder', shares: [shareOf(DANA, 'share-2')] }),
      makeTestBot({ id: 'vault', name: 'Vault' })
    ])
    dana = openSide("Dana's Mac", "Dana's Mac", [makeTestBot({ id: 'docs', name: 'Docs' })], {
      orchestrationEnvironmentTransport: {
        ...createOrchestrationEnvironmentTransport(),
        call: (selector, method, params) => callOwner(selector, method, params)
      }
    })
  })

  /** Dana's desktop says which shares it keeps, as its shared-agents owner does at startup. */
  function registerKeptShares(): void {
    setSharedHosts({
      host: (environmentId) =>
        loaded && kept.includes(environmentId) ? SHARES[environmentId]!.host : null,
      environmentIds: () => (loaded ? kept : []),
      ready: () => {
        shareReads += 1
        return sharesLoaded
      }
    })
  }

  afterEach(async () => {
    await ownerServer?.stop()
    dana.runtime.stopOrchestrationFederationRelay()
    owner.runtime.stopOrchestrationFederationRelay()
    dana.db.close()
    owner.db.close()
    setSharedHosts(null)
    delete journals[DOCS_CHAT]
    rmSync(dir, { recursive: true, force: true })
  })

  /** Docs, on Dana's computer, asks the shared agent by the name `bot list` gives its computer. */
  async function docsAsksRanger(params: Record<string, unknown> = {}) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send handler's receipt carries its message id.
    return (await send.handler(
      {
        from: DOCS_HOME,
        on: 'Ranger',
        to: 'bot:Ranger',
        subject: 'Cut a build',
        type: 'question',
        ...params
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
      { runtime: dana.runtime, orchestrationCaller: sessionCaller(DOCS_HOME) } as RpcContext
    )) as { message: { id: string } }
  }

  const requestOn = (side: Side, messageId: string) =>
    JSON.parse(side.db.getBotRequest(messageId)!.record)

  const call = async (name: string, params: Record<string, unknown>) => {
    const response = await new RpcDispatcher({
      runtime: dana.runtime,
      methods: PAIRED_SERVER_ASKS_METHODS
    }).dispatch(
      { id: `${name}_dana`, authToken: 'local', method: name, params },
      { caller: { kind: 'desktop' } }
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result
  }
  const Cards = z.object({ cards: z.array(z.object({ messageId: z.string() })) })
  const cards = async () => Cards.parse(await call('pairedServerAsks.list', {})).cards
  /** An agent on the owner's computer asks Docs on Dana's computer. */
  const ask = async (subject: string, from = RANGER_ASKS, onClient = 'install_dana') =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send handler's receipt carries its message id.
    (await send.handler(
      { from, onClient, to: 'bot:docs', subject, type: 'question' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
      { runtime: owner.runtime, orchestrationCaller: sessionCaller(from) } as RpcContext
    )) as { message: { id: string } }

  it("lists the shared agent's computer as a place mail can go, by its name", async () => {
    expect(await dana.runtime.listOrchestrationWorkerServers()).toEqual([
      { environmentId: SHARED_ENVIRONMENT, name: 'Ranger' }
    ])
    expect(await dana.runtime.resolveOrchestrationWorkerServer('Ranger')).toMatchObject({
      environmentId: SHARED_ENVIRONMENT,
      sharedHost: true
    })
  })

  it("lands a teammate's bot's ask in the teammate's Home, as the teammate's ask; the agent's answer comes back", async () => {
    const sent = await docsAsksRanger()

    const [request] = owner.db.getUnreadMessages(DANA_HOME_OF_RANGER)
    expect(request?.id).toBe(sent.message.id)
    // Dana's Home of Ranger, never the owner's: the owner's list gets nothing.
    expect(withChat.mock.calls.map(([botId, of]) => [botId, of])).toEqual([
      ['ranger', { accountId: DANA }]
    ])
    expect(owner.db.getUnreadMessages('orca_session_id:owner-home')).toEqual([])
    const record = requestOn(owner, sent.message.id)
    expect(record.askers).toEqual([DANA_AS_MEMBER])
    expect(turnActsForOwner({ askers: record.askers })).toBe(false)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    await ORCHESTRATION_REPLY_METHOD.handler({ id: request!.id, body: 'Build 42 is out.' }, {
      runtime: owner.runtime,
      orchestrationCaller: sessionCaller(DANA_HOME_OF_RANGER)
    } as RpcContext)
    await vi.waitFor(() =>
      expect(dana.db.getUnreadMessages(DOCS_HOME).map((mail) => mail.body)).toContain(
        'Build 42 is out.'
      )
    )
  })

  it('lands an ask sent with --chat in that chat of the agent, still as the teammate’s', async () => {
    const sent = await docsAsksRanger({ chat: `chat:${RANGER_THREAD}` })

    expect(owner.db.getUnreadMessages(RANGER_ASKS).map((mail) => mail.id)).toEqual([
      sent.message.id
    ])
    expect(withChat).not.toHaveBeenCalled()
    expect(requestOn(owner, sent.message.id).askers).toEqual([DANA_AS_MEMBER])
  })

  it("reaches only the agent shared with the teammate, never the owner's other bots", async () => {
    await expect(docsAsksRanger({ to: 'bot:Vault' })).rejects.toThrow(
      'Only the agent shared with you'
    )
    expect(owner.db.getUnreadMessages('orca_session_id:owner-home')).toEqual([])
  })

  it("asks the teammate's bot through its first-time card, then Always lets the next in", async () => {
    // Dana @-mentions Docs in Ranger's chat on her computer; her Orca then pulls from the share.
    await call('pairedServerAsks.introduce', {
      environmentId: SHARED_ENVIRONMENT,
      rootSession: RANGER_ASKS,
      botId: 'docs'
    })
    dana.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(listeningClients(owner.runtime, 'install_dana')).toHaveLength(1))

    const first = await ask('Review this PR?')
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    expect(dana.db.getUnreadMessages(DOCS_HOME)).toEqual([])
    await call('pairedServerAsks.decide', { messageId: first.message.id, decision: 'always' })
    await vi.waitFor(() => expect(dana.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1))

    await ask('And this one?')
    await vi.waitFor(() => expect(dana.db.getUnreadMessages(DOCS_HOME)).toHaveLength(2))
    expect(await cards()).toEqual([])

    // Docs's answer goes back to the agent that asked.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    await ORCHESTRATION_REPLY_METHOD.handler({ id: first.message.id, body: 'Approved.' }, {
      runtime: dana.runtime,
      orchestrationCaller: sessionCaller(DOCS_HOME)
    } as RpcContext)
    await vi.waitFor(() =>
      expect(owner.db.getUnreadMessages(RANGER_ASKS).map((mail) => mail.body)).toContain(
        'Approved.'
      )
    )
  })

  it('tells the sender an older shared computer cannot take its mail, and sends nothing', async () => {
    ownerCapabilities = (capabilities) =>
      capabilities.filter((name) => name !== ORCHESTRATION_TEAMMATE_PEER_MAIL_RUNTIME_CAPABILITY)

    await expect(docsAsksRanger()).rejects.toMatchObject({
      code: 'server_mail_unsupported',
      message: expect.stringContaining('older Orca')
    })
    expect(owner.db.getUnreadMessages(DANA_HOME_OF_RANGER)).toEqual([])
    expect(withChat).not.toHaveBeenCalled()
  })

  it('waits for the kept shares to load after a restart, never reading a share as removed', async () => {
    const server = await dana.runtime.resolveOrchestrationWorkerServer(SHARED_ENVIRONMENT)
    allowServer(dana.db, {
      serverKey: server.peerFingerprint,
      environmentId: SHARED_ENVIRONMENT,
      botId: 'docs'
    })
    // Restarted: the kept shares are still being read when the pull loops start.
    loaded = false
    let finishLoading = () => {}
    sharesLoaded = new Promise((resolve) => (finishLoading = resolve))
    const reads = shareReads
    dana.runtime.ensureOrchestrationFederationRelay()
    // The pull loop waits on the shares' load before reading any share as present or gone.
    await vi.waitFor(() => expect(shareReads).toBeGreaterThan(reads))
    loaded = true
    finishLoading()

    await vi.waitFor(() => expect(listeningClients(owner.runtime, 'install_dana')).toHaveLength(1))
    expect(isServerAllowed(dana.db, server.peerFingerprint, 'docs')).toBe(true)
  })

  it('keeps two agents shared from one computer apart, and each asks over its own share', async () => {
    kept = [SHARED_ENVIRONMENT, BUILDER_ENVIRONMENT]
    await call('pairedServerAsks.introduce', {
      environmentId: SHARED_ENVIRONMENT,
      rootSession: RANGER_ASKS,
      botId: 'docs'
    })
    await call('pairedServerAsks.allow', { environmentId: BUILDER_ENVIRONMENT, botId: 'docs' })
    dana.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(listeningClients(owner.runtime, 'install_dana')).toHaveLength(2))

    const sent = await ask('Review this PR?')
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    await call('pairedServerAsks.decide', { messageId: sent.message.id, decision: 'once' })
    await vi.waitFor(() => expect(dana.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1))
    // Neither share's pulls ended the other's.
    expect(listeningClients(owner.runtime, 'install_dana')).toHaveLength(2)
  })

  it("never takes asks from an older shared computer, which can't take a teammate's mail", async () => {
    ownerCapabilities = (capabilities) =>
      capabilities.filter((name) => name !== ORCHESTRATION_TEAMMATE_PEER_MAIL_RUNTIME_CAPABILITY)

    await expect(
      call('pairedServerAsks.introduce', {
        environmentId: SHARED_ENVIRONMENT,
        rootSession: RANGER_ASKS,
        botId: 'docs'
      })
    ).rejects.toThrow()
    expect(listeningClients(owner.runtime, 'install_dana')).toEqual([])
  })

  it('waits for this computer to say which shares it keeps, never reading a share as removed before', async () => {
    const server = await dana.runtime.resolveOrchestrationWorkerServer(SHARED_ENVIRONMENT)
    allowServer(dana.db, {
      serverKey: server.peerFingerprint,
      environmentId: SHARED_ENVIRONMENT,
      botId: 'docs'
    })
    // The pull loops start before the shared-agents owner registers (and `orca serve` never would).
    setSharedHosts(null)
    const gate = vi.mocked(sharedHostsReady)
    gate.mockClear()
    dana.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(gate).toHaveBeenCalled())
    let opened = false
    void gate.mock.results[0]!.value.then(() => (opened = true))
    // A zero-delay yield: a gate that were open would have settled by now.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opened).toBe(false)

    registerKeptShares()
    await vi.waitFor(() => expect(listeningClients(owner.runtime, 'install_dana')).toHaveLength(1))
    expect(isServerAllowed(dana.db, server.peerFingerprint, 'docs')).toBe(true)
  })

  it("never lets another agent ask over a shared agent's link", async () => {
    await call('pairedServerAsks.allow', { environmentId: SHARED_ENVIRONMENT, botId: 'docs' })
    dana.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(listeningClients(owner.runtime, 'install_dana')).toHaveLength(1))

    // An agent of the owner's that isn't shared with Dana: her Always for Ranger isn't for it.
    await expect(ask('Anything?', OTHER_AGENT)).rejects.toThrow('offline')
    await ask('Review this PR?')
    await vi.waitFor(() => expect(dana.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1))
  })

  it('ends a revoked share like a removed paired computer, telling its askers nothing new', async () => {
    mkdirSync(join(dir, 'owner-rpc'))
    ownerServer = new OrcaRuntimeRpcServer({
      runtime: owner.runtime,
      userDataPath: join(dir, 'owner-rpc'),
      enableWebSocket: true,
      wsPort: 0
    })
    await ownerServer.start()
    const device = await ownerServer.getBotShareDevices()!.add({
      botId: 'ranger',
      accountId: DANA,
      scope: 'runtime',
      devicePublicKeyB64: Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')
    })
    SHARES[SHARED_ENVIRONMENT] = share('ranger', device.deviceId, 'Ranger')
    await call('pairedServerAsks.introduce', {
      environmentId: SHARED_ENVIRONMENT,
      rootSession: RANGER_ASKS,
      botId: 'docs'
    })
    dana.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(listeningClients(owner.runtime, 'install_dana')).toHaveLength(1))
    await ask('Review this PR?')
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))

    expect(await ownerServer.revokeBotShareDevices('ranger', DANA)).toBe(true)

    expect(listeningClients(owner.runtime, 'install_dana')).toEqual([])
    await expect(ask('And this one?')).rejects.toThrow('offline')
    // The asking chat shows what it showed before: no notice about the revoke.
    expect(owner.db.getUnreadMessages(RANGER_ASKS)).toEqual([])
  })

  /** A computer paired with the owner's (not over a share) takes asks under Dana's computer's name. */
  async function pairedComputerPulls(deviceId: string, installationId: string): Promise<void> {
    const response = await new RpcDispatcher({
      runtime: owner.runtime,
      methods: ORCHESTRATION_METHODS
    }).dispatch(
      {
        id: `pull_${deviceId}`,
        authToken: '',
        method: 'orchestration.peerMailPull',
        params: {
          waitMs: 0,
          clientAsks: { session: deviceId, installationId, name: "Dana's Mac" }
        },
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
      },
      {
        authenticatedCallerFingerprint: `fingerprint-${deviceId}`,
        pairedDeviceId: deviceId,
        clientKind: 'runtime',
        callerScope: { kind: 'runtime-paired', grants: [] }
      }
    )
    expect(response.ok).toBe(true)
  }

  it("tells a computer's pairing and share apart, but never two computers of the same name", async () => {
    await call('pairedServerAsks.allow', { environmentId: SHARED_ENVIRONMENT, botId: 'docs' })
    dana.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(listeningClients(owner.runtime, 'install_dana')).toHaveLength(1))

    // The owner's own laptop, paired here, happens to share the name of Dana's computer.
    await pairedComputerPulls('owner-laptop', 'install_owner_laptop')
    await expect(ask('Review this PR?', RANGER_ASKS, "Dana's Mac")).rejects.toThrow(
      "Two paired computers answer to Dana's Mac"
    )

    // Dana's computer is also paired here: Ranger asks over its share, any other agent the pairing.
    await pairedComputerPulls('dana-paired', 'install_dana')
    await ask('Review this PR?')
    await vi.waitFor(() => expect(dana.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1))
    await expect(ask('Anything?', OTHER_AGENT)).resolves.toMatchObject({
      message: { id: expect.any(String) }
    })
  })
})
