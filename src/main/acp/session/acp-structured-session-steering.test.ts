import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURSOR_LAUNCH_SPEC } from '../../cursor/cursor-acp-launch-spec'
import { createQueuedMessageTestRig } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { HOST_TEST_SESSION } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { StructuredAgentSessionAdapterRouter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-router'
import { StructuredAgentRegistry } from '../../native-chat/agent-session-wire/providers/structured-agent-registry'
import type { AgentMessageSource } from '../../../shared/agent-session/journal/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { FakeAcpChild } from '../process/testing/acp-scripted-connection.test-fixture'
import { AcpScriptedAgent } from '../process/testing/acp-scripted-agent.test-support'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'

const MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail-notice', mailbox: 'term_sender', dispatchId: null, messages: [] }
}
const EXTENSION = '_session/steering'
const PROMPT = 'session/prompt'
const CANCEL = 'session/cancel'
const SESSION = 'native-session'
const MAIL_TEXT = 'Follow the coordinator instructions.'
const STEERING = { steering: { supported: true } }
const disposals: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposals.splice(0)) {
    await dispose()
  }
})

async function openChat(meta: unknown, provider: 'omp' | 'cursor' = 'omp') {
  const spec = provider === 'omp' ? acpLaunchSpecFor('omp')! : CURSOR_LAUNCH_SPEC
  const agent = new AcpScriptedAgent()
  agent.on('initialize', (request) =>
    agent.reply(request, { protocolVersion: 1, ...(meta === undefined ? {} : { _meta: meta }) })
  )
  agent.on('session/new', (request) => agent.reply(request, { sessionId: SESSION }))
  const launch = async () => ({
    spec,
    command: spec.command,
    prefixArgs: [],
    args: [],
    cwd: tmpdir(),
    env: {},
    envToDelete: [],
    fullAccess: false,
    resume: null
  })
  let host: StructuredAgentSessionHost | undefined
  const adapter = new AcpStructuredSessionAdapter({
    spec,
    resolveLaunch: launch,
    readLaunch: launch,
    dataDirectory: tmpdir(),
    readProcessStartTime: async () => 1,
    stopGraceMs: 1,
    connect: (input, options) => new FakeAcpChild(input, options, agent),
    onDispatchSettledLate: (settlement) => host?.settleLateDispatch(settlement),
    onEvent: (event) => host?.handleAdapterEvent(event)
  })
  const agents = new StructuredAgentRegistry([
    { definition: acpStructuredAgentDefinition(spec), adapter }
  ])
  const router = new StructuredAgentSessionAdapterRouter(agents, () => adapter.closeAll())
  const rig = await createQueuedMessageTestRig({
    attach: {
      provider,
      agent: provider,
      providerHandle: undefined,
      accountHome: {
        variable: provider === 'omp' ? 'PI_CODING_AGENT_DIR' : 'CURSOR_CONFIG_DIR',
        path: join(tmpdir(), 'agent-account')
      }
    },
    hostDeps: { agents, adapter: router }
  })
  host = rig.host
  disposals.push(async () => {
    await rig.dispose()
    await router.closeAll()
    agent.close()
  })
  const request = async (method: string, index = 0) => {
    const frames = () => agent.frames.filter((frame) => frame.method === method)
    await vi.waitFor(() => expect(frames(), JSON.stringify(agent.frames)).toHaveLength(index + 1))
    return frames()[index]!
  }
  const send = rig.send('Keep working.')
  expect(await send.result).toMatchObject({ ok: true })
  const first = await request(PROMPT)
  await eventually(async () => {
    expect(await rig.submission(send.id)).toMatchObject({ dispatchState: 'accepted' })
  })
  const finish = async (stopReason: 'end_turn' | 'cancelled' = 'end_turn') => {
    agent.reply(first, { stopReason })
    await eventually(async () => {
      const history = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
      expect(history).toMatchObject({
        ok: true,
        page: {
          items: expect.arrayContaining([
            expect.objectContaining({
              body: expect.objectContaining({
                kind: 'turn',
                userItemId: agentJournalSubmissionKey(send.id),
                state: stopReason === 'end_turn' ? 'completed' : 'interrupted'
              })
            })
          ])
        }
      })
    })
  }
  const mail = async () => {
    const result = await rig.send(MAIL_TEXT, 'queue-if-active', { internal: true, from: MAIL })
      .result
    if (!result.ok || !('queued' in result.value)) {
      throw new Error(`Expected a mail card: ${JSON.stringify(result)}`)
    }
    return result.value.queued.messageId
  }
  const submissions = async (draft: string) => {
    await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    return (await journal.reads.input({ kind: 'linked-to', messageId: draft })).submissions
  }
  const methods = () =>
    agent.frames
      .map(({ method }) => method)
      .filter((method) => method === PROMPT || method === CANCEL || method === EXTENSION)
  return { rig, agent, request, finish, mail, submissions, methods }
}

describe('ACP orchestration mail steering', () => {
  it('settles an injected card once and places its original message in the running turn', async () => {
    const chat = await openChat(STEERING)
    const draft = await chat.mail()
    const steer = await chat.request(EXTENSION)
    expect(steer.params).toEqual({
      sessionId: SESSION,
      prompt: [{ type: 'text', text: MAIL_TEXT }]
    })
    chat.agent.reply(steer, { outcome: 'injected', queue: 'steering' })
    await eventually(async () => {
      expect(await chat.submissions(draft)).toMatchObject([
        { dispatchState: 'accepted', answeredInTurn: { via: 'steer' } }
      ])
    })
    const [delivery] = await chat.submissions(draft)
    const history = await chat.rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    expect(history).toMatchObject({
      ok: true,
      page: {
        items: expect.arrayContaining([
          expect.objectContaining({
            itemId: agentJournalSubmissionKey(delivery.clientMessageId),
            body: expect.objectContaining({ blocks: [{ type: 'text', text: MAIL_TEXT }] })
          }),
          expect.objectContaining({
            itemId: delivery.answeredInTurn!.turnItemId,
            body: expect.objectContaining({ kind: 'turn', state: 'running' })
          })
        ])
      }
    })
    await chat.finish()
    expect(chat.methods()).toEqual([PROMPT, EXTENSION])
    expect(await chat.submissions(draft)).toHaveLength(1)
  })

  it.each(['before', 'after'] as const)(
    'prompts once without cancellation when promptRequired arrives %s the active prompt ends',
    async (order) => {
      const chat = await openChat(STEERING)
      const draft = await chat.mail()
      const steer = await chat.request(EXTENSION)
      if (order === 'after') {
        await chat.finish()
      }
      expect(chat.methods()).toEqual([PROMPT, EXTENSION])
      chat.agent.reply(steer, { outcome: 'promptRequired', queue: 'steering' })
      if (order === 'before') {
        await chat.submissions(draft)
        expect(chat.methods()).toEqual([PROMPT, EXTENSION])
        await chat.finish()
      }
      const next = await chat.request(PROMPT, 1)
      expect(next.params).toEqual({
        sessionId: SESSION,
        prompt: [{ type: 'text', text: MAIL_TEXT }]
      })
      chat.agent.reply(next, { stopReason: 'end_turn' })
      await eventually(async () => {
        expect(await chat.submissions(draft)).toMatchObject([{ dispatchState: 'accepted' }])
      })
      expect(chat.methods()).toEqual([PROMPT, EXTENSION, PROMPT])
    }
  )

  it.each(['failed', 'rpc-error'] as const)(
    'falls back to one cancel and one prompt on %s',
    async (failure) => {
      const chat = await openChat(STEERING)
      const draft = await chat.mail()
      const steer = await chat.request(EXTENSION)
      if (failure === 'failed') {
        chat.agent.reply(steer, { outcome: 'failed', reason: 'not admitted' })
      } else {
        chat.agent.fail(steer, -32601, 'Method not found')
      }
      await chat.request(CANCEL)
      await chat.finish('cancelled')
      const next = await chat.request(PROMPT, 1)
      expect(next.params).toEqual({
        sessionId: SESSION,
        prompt: [{ type: 'text', text: MAIL_TEXT }]
      })
      chat.agent.reply(next, { stopReason: 'end_turn' })
      await eventually(async () => {
        expect(await chat.submissions(draft)).toMatchObject([{ dispatchState: 'accepted' }])
      })
      expect(chat.methods()).toEqual([PROMPT, EXTENSION, CANCEL, PROMPT])
    }
  )

  it('admits mail mid-turn only for OMP with initialize support', async () => {
    const supported = await openChat(STEERING)
    await supported.mail()
    supported.agent.reply(await supported.request(EXTENSION), {
      outcome: 'injected',
      queue: 'steering'
    })
    await supported.finish()
    for (const [provider, meta] of [
      ['omp', undefined],
      ['cursor', STEERING]
    ] as const) {
      const chat = await openChat(meta, provider)
      const draft = await chat.mail()
      expect(await chat.submissions(draft)).toEqual([])
      expect(chat.methods()).toEqual([PROMPT])
      await chat.finish()
      chat.agent.reply(await chat.request(PROMPT, 1), { stopReason: 'end_turn' })
      await eventually(async () => {
        expect(await chat.submissions(draft)).toMatchObject([{ dispatchState: 'accepted' }])
      })
      expect(chat.methods()).toEqual([PROMPT, PROMPT])
    }
  })
})
