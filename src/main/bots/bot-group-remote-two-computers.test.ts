import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { BotGroupRemoteAsk } from '../../shared/bots/bot-group'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { OrchestrationEnvironmentTransport } from '../runtime/orchestration/federation/environment-transport'
import type { OrchestrationSessionCaller } from '../runtime/orchestration/addressing/orchestration-caller-identity'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcContext } from '../runtime/rpc/core'
import { ORCHESTRATION_METHODS } from '../runtime/rpc/methods/orchestration/orchestration'
import { ORCHESTRATION_REPLY_METHOD } from '../runtime/rpc/methods/orchestration/messaging/reply-method'
import { dropUnreadBotRequests } from '../runtime/rpc/methods/orchestration/messaging/bot-request-outcome'
import type * as RecipientRouting from '../runtime/rpc/methods/orchestration/messaging/recipient-routing'
import {
  DOCS_CHAT,
  withChat
} from '../runtime/rpc/methods/orchestration/messaging/bot-recipient.test-fixture'
import { makeTestBot } from './bot.test-fixture'
import { runtimeBotGroups } from './bot-group-runtime'

vi.mock(
  '../runtime/orchestration/federation/relay/federation-relay-scheduler',
  async (original) => ({ ...(await original<object>()), federationRelayRetryDelayMs: () => 0 })
)
vi.mock(
  './bot-session-tabs',
  async () =>
    (await import('../runtime/rpc/methods/orchestration/messaging/bot-recipient.test-fixture'))
      .botSessionTabsMock
)
vi.mock(
  './bot-chat-session',
  async () =>
    (await import('../runtime/rpc/methods/orchestration/messaging/bot-recipient.test-fixture'))
      .botChatSessionMock
)
vi.mock(
  './bot-chat-mail-hold',
  async () =>
    (await import('../runtime/rpc/methods/orchestration/messaging/bot-recipient.test-fixture'))
      .botChatMailHoldMock
)
vi.mock(
  './bot-chat-status-line',
  async () =>
    (await import('../runtime/rpc/methods/orchestration/messaging/bot-recipient.test-fixture'))
      .botChatStatusLineMock
)
vi.mock(
  '../runtime/rpc/methods/orchestration/messaging/recipient-routing',
  async (importOriginal) =>
    (
      await import('../runtime/rpc/methods/orchestration/messaging/bot-recipient.test-fixture')
    ).recipientRoutingMock(await importOriginal<typeof RecipientRouting>())
)

const DOCS_HOME = `orca_session_id:${DOCS_CHAT}`
const DOCS = { id: 'docs', name: 'Docs' }

type Side = { db: OrchestrationDb; runtime: OrcaRuntimeService; dispatcher: RpcDispatcher }

// A desktop G whose group holds Ranger (on G) and Docs (on the paired server B).
describe('a group on one computer with a bot on another', () => {
  let dir: string
  let g: Side
  let b: Side
  let bBots: ReturnType<typeof makeTestBot>[]

  function openSide(
    name: string,
    machine: string,
    bots: () => ReturnType<typeof makeTestBot>[],
    transport?: OrchestrationEnvironmentTransport
  ): Side {
    const db = new OrchestrationDb(join(dir, `${name}.db`))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    vi.spyOn(runtime, 'readMachineName').mockReturnValue(machine)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    vi.spyOn(runtime.bots, 'list').mockImplementation(bots)
    vi.spyOn(runtime.bots, 'enabled').mockReturnValue(true)
    vi.spyOn(runtime.bots, 'assertEnabled').mockReturnValue(undefined)
    vi.spyOn(runtime.bots, 'createGroupHome').mockResolvedValue({
      folder: 'group-crew',
      folderWorkspaceId: 'group-home-1'
    })
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'listAutomationRuns').mockReturnValue([])
    runtime.setOrchestrationDb(db)
    return {
      db,
      runtime,
      dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    }
  }

  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => ({
      environmentId: 'env_b',
      name: 'Build Box',
      peerFingerprint: 'fingerprint_b',
      homePeerFingerprint: 'fingerprint_g'
    }),
    hasEnvironment: () => true,
    call: async (_selector, method, params) => {
      if (method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: b.runtime.getStatus(),
          _meta: { runtimeId: b.runtime.getRuntimeId() }
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
      return (await b.dispatcher.dispatch(
        {
          id: `from_g_${method}`,
          authToken: 'g-device-token',
          method,
          params,
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
        },
        {
          authenticatedCallerFingerprint: 'fingerprint_g',
          pairedDeviceId: 'device_g',
          clientKind: 'runtime'
        }
      )) as RuntimeRpcResponse<unknown>
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-group-two-computers-'))
    withChat.mockReset()
    withChat.mockImplementation((_botId, work) => work(DOCS_CHAT))
    bBots = [makeTestBot(DOCS)]
    b = openSide('b', 'Build Box', () => bBots)
    g = openSide(
      'g',
      "Alice's Mac",
      () => [makeTestBot({ id: 'ranger', name: 'Ranger' })],
      transport
    )
  })

  afterEach(() => {
    g.runtime.stopOrchestrationFederationRelay()
    b.runtime.stopOrchestrationFederationRelay()
    g.db.close()
    b.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const groups = () => runtimeBotGroups(g.runtime)

  async function crew() {
    return groups().create({
      name: 'Crew',
      botIds: ['ranger'],
      remoteBots: [
        {
          environmentId: 'env_b',
          botId: 'docs',
          chatSessionId: DOCS_CHAT,
          name: 'Docs',
          avatar: null,
          agent: 'claude'
        }
      ]
    })
  }

  async function post(group: { id: string; revision: number }, text: string) {
    const message = await groups().send(
      { groupId: group.id, revision: group.revision, messageId: randomUUID(), text },
      { local: true }
    )
    await vi.waitFor(() =>
      expect(groups().store.message(message.id)?.remoteAsks?.[0]?.state).not.toBe('sending')
    )
    return groups().store.message(message.id)!
  }

  const shown = (group: { id: string }, messageId: string): BotGroupRemoteAsk | undefined =>
    groups()
      .read(group.id)
      .messages.find((message) => message.id === messageId)?.remoteAsks?.[0]

  function reply(id: string, body: string) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    const orchestrationCaller = {
      address: DOCS_HOME,
      terminalHandle: null,
      paneKey: null,
      orcaSessionId: DOCS_CHAT,
      sessionId: DOCS_CHAT,
      workspaceId: 'w'
    } as OrchestrationSessionCaller
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    const context = { runtime: b.runtime, orchestrationCaller } as RpcContext
    return ORCHESTRATION_REPLY_METHOD.handler({ id, body }, context)
  }

  it("asks Docs in its Home Chat on B, and posts its answer in G's room", async () => {
    const group = await crew()
    const message = await post(group, '@Docs where is the install guide?')
    expect(message.remoteAsks?.[0]).toMatchObject({ state: 'sent', computer: 'Build Box' })
    const [request] = b.db.getUnreadMessages(DOCS_HOME)
    expect(request).toMatchObject({ id: message.remoteAsks![0].requestId, type: 'question' })
    expect(request!.body).toContain('where is the install guide?')

    // No relay was started by hand: the send started it.
    await reply(request!.id, 'docs/install.md')
    await vi.waitFor(() =>
      expect(shown(group, message.id)?.reply).toEqual({ kind: 'answer', text: 'docs/install.md' })
    )
  })

  it("shows B's notice when Docs won't answer, then the answer that follows it", async () => {
    const group = await crew()
    const message = await post(group, '@Docs check the guide')
    await dropUnreadBotRequests(b.runtime, 'docs', 'paused')
    await vi.waitFor(() => expect(shown(group, message.id)?.reply).toEqual({ kind: 'notice' }))
    await reply(message.remoteAsks![0].requestId, 'Back: done.')
    await vi.waitFor(() =>
      expect(shown(group, message.id)?.reply).toEqual({ kind: 'answer', text: 'Back: done.' })
    )
  })

  it('never asks another bot that took the name of a deleted member', async () => {
    const group = await crew()
    // Docs is deleted on B, and a different bot now answers to "docs" by name.
    bBots = [makeTestBot({ id: 'impostor', name: 'docs' })]
    const message = await post(group, '@Docs hello')
    // B refuses the chat that isn't the impostor's; G can't prove it wasn't taken, so not "sent".
    expect(message.remoteAsks?.[0]).toMatchObject({
      state: 'unknown',
      error: expect.stringContaining('has no chat')
    })
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('reads an ask cut off before G saved it as unknown, and still takes its answer', async () => {
    const group = await crew()
    const message = await post(group, '@Docs status?')
    // As a crash after B admitted it but before G saved that leaves it.
    groups().store.update({
      ...message,
      remoteAsks: message.remoteAsks!.map((ask) => ({ ...ask, state: 'sending' as const }))
    })
    expect(shown(group, message.id)?.state).toBe('unknown')
    expect(b.db.getUnreadMessages(DOCS_HOME)).toHaveLength(1)
    await reply(message.remoteAsks![0].requestId, 'Green.')
    await vi.waitFor(() =>
      expect(shown(group, message.id)?.reply).toEqual({ kind: 'answer', text: 'Green.' })
    )
  })
})
