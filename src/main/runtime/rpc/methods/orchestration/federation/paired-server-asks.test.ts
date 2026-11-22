import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { listeningClients } from '../../../../orchestration/federation/client-asks/client-ask-listeners'
import { allowServer } from '../../../../orchestration/db/federation/paired-server-asks-store'
import { importPairedServerItem } from '../../../../orchestration/federation/paired-server-asks/paired-server-ask-import'
import { activePairedServerAsks } from '../../../../orchestration/federation/paired-server-asks/paired-server-asks-loop'
import { settleRemovedPairedServer } from '../../../../orchestration/federation/peer-mail/paired-server-changes'
import { settlePairedServerAsksOnRemoval } from '../../../../orchestration/federation/paired-server-asks/paired-server-ask-removal'
import { RpcDispatcher } from '../../../dispatcher'
import { BOT_REQUEST_OUTCOME_METHOD } from '../../bots-request-outcome'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { ORCHESTRATION_REPLY_METHOD } from '../messaging/reply-method'
import { PAIRED_SERVER_ASKS_METHODS } from '../../paired-server-asks/paired-server-asks-methods'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import type * as RecipientRouting from '../messaging/recipient-routing'
import { DOCS_CHAT, RANGER_THREAD, withChat } from '../messaging/bot-recipient.test-fixture'

vi.mock(
  '../../../../orchestration/federation/relay/federation-relay-scheduler',
  async (original) => ({
    ...(await original<object>()),
    federationRelayRetryDelayMs: () => 0
  })
)
vi.mock('../../../../hosts/platform-probe/host-descriptor', async (original) => ({
  ...(await original<object>()),
  getPublishedHostDescriptor: () => ({ installationId: 'install_a' })
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

// The asker is a chat on the server; Docs is a bot on this computer.
const ClientAsks = z.object({ clientAsks: z.object({ previousPairing: z.string().optional() }) })
const PulledRow = z.object({
  dispatch_id: z.string(),
  message_id: z.string(),
  kind: z.string(),
  payload: z.string()
})
const PullParams = z.record(z.string(), z.unknown())
const ASKER = `orca_session_id:${RANGER_THREAD}`
const DOCS_HOME = `orca_session_id:${DOCS_CHAT}`

type Side = { db: OrchestrationDb; runtime: OrcaRuntimeService; dispatcher: RpcDispatcher }

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

describe('agents on a paired server messaging an agent on this computer', () => {
  let dir: string
  let server: Side
  let computer: Side

  function openSide(
    name: string,
    machine: string,
    bots: ReturnType<typeof makeTestBot>[],
    transport?: OrchestrationEnvironmentTransport
  ): Side {
    const db = new OrchestrationDb(join(dir, `${name}.db`))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    vi.spyOn(runtime, 'readMachineName').mockReturnValue(machine)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    vi.spyOn(runtime.bots, 'list').mockReturnValue(bots)
    vi.spyOn(runtime.bots, 'enabled').mockReturnValue(true)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue([])
    runtime.setOrchestrationDb(db)
    return {
      db,
      runtime,
      dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    }
  }

  // The computer's credential on the server, how many status reads fail next, and its pulls.
  let pairing = 'fingerprint_a'
  let statusFailures = 0
  let pulls: Record<string, unknown>[] = []
  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => ({
      environmentId: 'env_s',
      name: 'Build Box',
      peerFingerprint: 'fingerprint_s',
      homePeerFingerprint: pairing
    }),
    list: async () => [{ environmentId: 'env_s', name: 'Build Box' }],
    hasEnvironment: () => true,
    call: async (_selector, method, rawParams) => {
      const pull = method === 'orchestration.peerMailPull' ? PullParams.parse(rawParams) : null
      if (pull) {
        pulls.push(pull)
        // Short waits, so a test sees the loop's next pull.
        pull.waitMs = Math.min(Number(pull.waitMs ?? 0), 100)
      }
      const params = pull ?? rawParams
      if (method === 'status.get') {
        if (statusFailures > 0) {
          statusFailures -= 1
          throw new Error('Build Box is not answering yet')
        }
        const status = server.runtime.getStatus()
        return {
          id: 'status',
          ok: true,
          result: {
            ...status,
            capabilities: [
              ...(status.capabilities ?? []),
              ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY
            ],
            hostDescriptor: { installationId: 'install_s' }
          },
          _meta: { runtimeId: server.runtime.getRuntimeId() }
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
      return (await server.dispatcher.dispatch(
        {
          id: `from_computer_${method}`,
          authToken: 'computer-token',
          method,
          params,
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
        },
        {
          authenticatedCallerFingerprint: pairing,
          pairedDeviceId: 'device_a',
          clientKind: 'runtime'
        }
      )) as RuntimeRpcResponse<unknown>
    }
  }

  beforeEach(() => {
    pairing = 'fingerprint_a'
    statusFailures = 0
    pulls = []
    dir = mkdtempSync(join(tmpdir(), 'orca-paired-server-asks-'))
    withChat.mockReset()
    withChat.mockImplementation((_botId, work) => work(DOCS_CHAT))
    server = openSide('server', 'Build Box', [makeTestBot({ id: 'ranger', name: 'Ranger' })])
    computer = openSide(
      'computer',
      "Alice's Mac",
      [makeTestBot({ id: 'docs', name: 'Docs' })],
      transport
    )
  })

  afterEach(() => {
    computer.runtime.stopOrchestrationFederationRelay()
    server.runtime.stopOrchestrationFederationRelay()
    computer.db.close()
    server.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  let callCount = 0
  /** A paired-server-asks call on this computer, from a person in its window unless `asAgent`. */
  async function call(name: string, params: Record<string, unknown>, asAgent = false) {
    callCount += 1
    const response = await new RpcDispatcher({
      runtime: computer.runtime,
      methods: PAIRED_SERVER_ASKS_METHODS
    }).dispatch(
      { id: `${name}_${callCount}`, authToken: 'local', method: name, params },
      asAgent ? {} : { caller: { kind: 'desktop' } }
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result
  }

  async function listening(): Promise<void> {
    computer.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(listeningClients(server.runtime, 'install_a')).toHaveLength(1))
  }

  async function introduce(): Promise<void> {
    await call('pairedServerAsks.introduce', {
      environmentId: 'env_s',
      rootSession: ASKER,
      botId: 'docs'
    })
    await listening()
  }

  async function ask(params: Record<string, unknown> = {}) {
    const send = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.send')!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    const context = {
      runtime: server.runtime,
      orchestrationCaller: sessionCaller(ASKER)
    } as RpcContext
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send handler's receipt for a paired computer carries its message id.
    return (await send.handler(
      {
        from: ASKER,
        onClient: 'install_a',
        to: 'bot:docs',
        subject: 'Where is the install guide?',
        type: 'question',
        ...params
      },
      context
    )) as { message: { id: string } }
  }

  const Cards = z.object({
    cards: z.array(z.object({ messageId: z.string(), botId: z.string(), subject: z.string() }))
  })
  const cards = async () => Cards.parse(await call('pairedServerAsks.list', {})).cards

  const awaiting = (id: string) =>
    server.db.db.prepare('SELECT awaiting FROM peer_questions_out WHERE message_id = ?').get(id)
      ?.awaiting

  it('shows a card for an introduced agent; allowed once, its answer comes back and settles the question', async () => {
    await introduce()
    const sent = await ask()
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    expect((await cards())[0]).toMatchObject({ messageId: sent.message.id, botId: 'docs' })

    await call('pairedServerAsks.decide', { messageId: sent.message.id, decision: 'once' })
    await vi.waitFor(() => expect(computer.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1))
    const [request] = computer.db.getUnreadMessages(DOCS_HOME)
    expect(request!.id).toBe(sent.message.id)
    expect(await cards()).toEqual([])

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    await ORCHESTRATION_REPLY_METHOD.handler({ id: request!.id, body: 'docs/install.md' }, {
      runtime: computer.runtime,
      orchestrationCaller: sessionCaller(DOCS_HOME)
    } as RpcContext)

    await vi.waitFor(() => expect(server.db.getUnreadMessages(ASKER)).toHaveLength(1))
    expect(server.db.getUnreadMessages(ASKER)[0]).toMatchObject({ body: 'docs/install.md' })
    expect(awaiting(sent.message.id)).toBeNull()
  })

  it('hands the asker a follow-up reply straight to the agent, with no card', async () => {
    await introduce()
    const sent = await ask()
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    await call('pairedServerAsks.decide', { messageId: sent.message.id, decision: 'once' })
    await vi.waitFor(() => expect(computer.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    await ORCHESTRATION_REPLY_METHOD.handler({ id: sent.message.id, body: 'docs/install.md' }, {
      runtime: computer.runtime,
      orchestrationCaller: sessionCaller(DOCS_HOME)
    } as RpcContext)
    await vi.waitFor(() => expect(server.db.getUnreadMessages(ASKER)).toHaveLength(1))
    const [answer] = server.db.getUnreadMessages(ASKER)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    await ORCHESTRATION_REPLY_METHOD.handler({ id: answer!.id, body: 'Thanks, found it.' }, {
      runtime: server.runtime,
      orchestrationCaller: sessionCaller(ASKER)
    } as RpcContext)

    await vi.waitFor(() =>
      expect(computer.db.getAllMessagesForHandle(DOCS_HOME).map((mail) => mail.body)).toContain(
        'Thanks, found it.'
      )
    )
    expect(await cards()).toEqual([])
  })

  it('declines an ask for an agent no one introduced, with no card', async () => {
    await call('pairedServerAsks.allow', { environmentId: 'env_s', botId: 'other' })
    await listening()
    const sent = await ask()

    await vi.waitFor(() => expect(server.db.getUnreadMessages(ASKER)).toHaveLength(1))
    expect(server.db.getUnreadMessages(ASKER)[0]!.body).toBe("Declined on Alice's Mac.")
    expect(awaiting(sent.message.id)).toBeNull()
    expect(await cards()).toEqual([])
  })

  it('admits every ask from an allowed server with no card', async () => {
    await call('pairedServerAsks.allow', { environmentId: 'env_s', botId: 'docs' })
    await listening()
    await ask({ type: 'status', subject: 'Heads up' })
    await ask({ type: 'status', subject: 'Second note' })

    await vi.waitFor(() => expect(computer.db.getUnreadMessages(DOCS_HOME)).toHaveLength(2))
    expect(await cards()).toEqual([])
  })

  it('always allow lets the next ask from that server in without a card', async () => {
    await introduce()
    const first = await ask()
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    await call('pairedServerAsks.decide', { messageId: first.message.id, decision: 'always' })
    await ask({ type: 'status', subject: 'Follow-up' })

    await vi.waitFor(() => expect(computer.db.getUnreadMessages(DOCS_HOME)).toHaveLength(2))
    expect(await call('pairedServerAsks.allowances', { botId: 'docs' })).toEqual({
      servers: [{ serverInstallationId: 'install_s', environmentId: 'env_s' }]
    })
  })

  it('tells the asker it was declined when the card is denied, and only a person can answer', async () => {
    await introduce()
    const sent = await ask()
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))

    await expect(
      call('pairedServerAsks.decide', { messageId: sent.message.id, decision: 'once' }, true)
    ).rejects.toThrow('Only a person')

    await call('pairedServerAsks.decide', { messageId: sent.message.id, decision: 'deny' })

    await vi.waitFor(() => expect(server.db.getUnreadMessages(ASKER)).toHaveLength(1))
    expect(server.db.getUnreadMessages(ASKER)[0]!.body).toBe("Declined on Alice's Mac.")
    expect(awaiting(sent.message.id)).toBeNull()
    expect(computer.db.getUnreadMessages(DOCS_HOME)).toEqual([])
  })

  it('declines a waiting card and stops listening before a removed pairing loses its credential', async () => {
    await introduce()
    const sent = await ask()
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))

    await settlePairedServerAsksOnRemoval(computer.runtime, 'env_s')

    expect(server.db.getUnreadMessages(ASKER)[0]?.body).toBe("Declined on Alice's Mac.")
    expect(awaiting(sent.message.id)).toBeNull()
    expect(listeningClients(server.runtime, 'install_a')).toEqual([])
    expect(await cards()).toEqual([])
  })

  it('names itself on the running loop once the server can be read', async () => {
    computer.runtime.stopOrchestrationFederationRelay()
    computer.db.close()
    statusFailures = Number.POSITIVE_INFINITY
    computer = openSide(
      'computer_offline',
      "Alice's Mac",
      [makeTestBot({ id: 'docs', name: 'Docs' })],
      transport
    )
    allowServer(computer.db, {
      serverInstallationId: 'install_s',
      environmentId: 'env_s',
      botId: 'docs'
    })
    computer.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(pulls.length).toBeGreaterThan(1))
    expect(listeningClients(server.runtime, 'install_a')).toEqual([])

    statusFailures = 0
    await listening()
  })

  it('announces a re-pair on the running loop, naming the pairing it replaced', async () => {
    await introduce()
    pairing = 'fingerprint_a2'
    await vi.waitFor(() =>
      expect(
        pulls.some(
          (pull) => ClientAsks.safeParse(pull).data?.clientAsks.previousPairing === 'fingerprint_a'
        )
      ).toBe(true)
    )
  })

  it('tells the asker of an admitted, unanswered question that the pairing was removed', async () => {
    await introduce()
    const sent = await ask()
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    await call('pairedServerAsks.decide', { messageId: sent.message.id, decision: 'once' })
    await vi.waitFor(() => expect(computer.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1))

    await settlePairedServerAsksOnRemoval(computer.runtime, 'env_s')

    const told = server.db.getUnreadMessages(ASKER)
    expect(told).toHaveLength(1)
    expect(told[0]!.body).toContain("Docs's owner unpaired its computer from this one")
    expect(awaiting(sent.message.id)).toBeNull()
  })

  it('declines a waiting card on removal even with no pull loop running', async () => {
    await introduce()
    const sent = await ask()
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    computer.runtime.stopOrchestrationFederationRelay()
    await vi.waitFor(() =>
      expect(activePairedServerAsks(computer.runtime, 'env_s')).toBeUndefined()
    )

    await settlePairedServerAsksOnRemoval(computer.runtime, 'env_s')

    expect(server.db.getUnreadMessages(ASKER)[0]?.body).toBe("Declined on Alice's Mac.")
    expect(awaiting(sent.message.id)).toBeNull()
  })

  it('queues one decline when a pulled ask is imported again', async () => {
    await call('pairedServerAsks.allow', { environmentId: 'env_s', botId: 'other' })
    await listening()
    const sent = await ask()
    await vi.waitFor(() => expect(server.db.getUnreadMessages(ASKER)).toHaveLength(1))
    const item = PulledRow.parse(
      server.db.db
        .prepare(
          'SELECT dispatch_id, message_id, kind, payload FROM federation_relay_items WHERE message_id = ?'
        )
        .get(sent.message.id)
    )

    await importPairedServerItem(
      computer.runtime,
      computer.db,
      activePairedServerAsks(computer.runtime, 'env_s')!,
      {
        conversationId: item.dispatch_id,
        messageId: item.message_id,
        kind: item.kind,
        payload: item.payload
      }
    )

    expect(
      computer.db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM federation_relay_items WHERE dispatch_id = ? AND direction = 'to_home'"
        )
        .get(item.dispatch_id)
    ).toEqual({ count: 1 })
  })

  it('drops cards and allowances of a server a loop finds removed', async () => {
    await introduce()
    await call('pairedServerAsks.allow', { environmentId: 'env_s', botId: 'docs' })
    await ask({ to: 'bot:docs', type: 'status', subject: 'Heads up' })

    settleRemovedPairedServer(computer.runtime, computer.db, 'env_s', 'Build Box')

    expect(await cards()).toEqual([])
    expect(await call('pairedServerAsks.allowances', { botId: 'docs' })).toEqual({ servers: [] })
  })

  it("reads the asking chat's card from the server: waiting, then declined or answered", async () => {
    // As a window paired to the server reads it.
    const outcome = (messageId: string) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
      BOT_REQUEST_OUTCOME_METHOD.handler({ messageId, onClient: true }, {
        runtime: server.runtime,
        pairedDeviceId: 'device_b'
      } as RpcContext)
    await introduce()
    const denied = await ask()
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    expect(outcome(denied.message.id)).toMatchObject({ outcome: null, answer: null })
    await call('pairedServerAsks.decide', { messageId: denied.message.id, decision: 'deny' })
    await vi.waitFor(() => expect(outcome(denied.message.id).outcome).toBe('dropped'))

    const answered = await ask({ subject: 'Second question' })
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    await call('pairedServerAsks.decide', { messageId: answered.message.id, decision: 'once' })
    await vi.waitFor(() =>
      expect(computer.db.getUnreadMessages(DOCS_HOME).map((mail) => mail.id)).toContain(
        answered.message.id
      )
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    await ORCHESTRATION_REPLY_METHOD.handler({ id: answered.message.id, body: 'docs/install.md' }, {
      runtime: computer.runtime,
      orchestrationCaller: sessionCaller(DOCS_HOME)
    } as RpcContext)
    await vi.waitFor(() =>
      expect(outcome(answered.message.id)).toMatchObject({
        outcome: 'answered',
        answer: 'docs/install.md'
      })
    )

    const unpaired = await ask({ subject: 'Third question' })
    await vi.waitFor(async () => expect(await cards()).toHaveLength(1))
    await call('pairedServerAsks.decide', { messageId: unpaired.message.id, decision: 'once' })
    await vi.waitFor(() =>
      expect(computer.db.getUnreadMessages(DOCS_HOME).map((mail) => mail.id)).toContain(
        unpaired.message.id
      )
    )
    await settlePairedServerAsksOnRemoval(computer.runtime, 'env_s')
    await vi.waitFor(() => expect(outcome(unpaired.message.id).outcome).toBe('dropped'))
    expect(outcome(unpaired.message.id).answer).toContain(
      "Docs's owner unpaired its computer from this one"
    )
  })
})
