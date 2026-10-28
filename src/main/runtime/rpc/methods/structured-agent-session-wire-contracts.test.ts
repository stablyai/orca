import '../unused-default-rpc-methods.test-fixture'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../../shared/agent-session-optional-model-capability'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import {
  AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY,
  AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY,
  RUNTIME_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../../../shared/agent-session-current-requests-capability'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { AcpStructuredOptions } from '../../../acp/acp-structured-options'
import { NewSessionResponseSchema } from '../../../acp/generated/acp-protocol.generated'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from '../../../native-chat/agent-session-wire/structured-agent-session-send-settlement'
import type { AgentSessionSubscribeInput } from '../../../native-chat/agent-session-wire/structured-agent-session-subscribers'
import { parseRuntimeClientCapabilities } from '../runtime-client-capabilities'
import {
  attachParams,
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  openStream,
  SESSION,
  sendParams,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import {
  createQueuedMessageTestRig,
  eventually
} from '../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as HOST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { holdDelivery } from '../../../native-chat/agent-session-wire/structured-agent-session-delivery-hold.test-fixture'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

const currentDesktop = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY,
    AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY
  ]
}

it.each([
  // Being a phone is enough: no capability or param is asked of it.
  ['a phone of any version', STRUCTURED_MOBILE_CLIENT, true, true],
  ['an older paired desktop', STRUCTURED_CLIENT, false, false],
  [
    'a desktop that only settles skipped sends',
    {
      ...STRUCTURED_CLIENT,
      clientCapabilities: [
        ...STRUCTURED_CLIENT.clientCapabilities,
        AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY
      ]
    },
    false,
    false
  ],
  ['an updated paired desktop', currentDesktop, false, true],
  ['an in-process reader', undefined, false, true]
] as const)('subscribes %s with bounded frames: %s', async (_label, client, bounded, snapshot) => {
  let input: AgentSessionSubscribeInput | undefined
  hostCalls.subscribe.mockImplementation((opened: AgentSessionSubscribeInput) => {
    input = opened
    opened.emit({ type: 'end' })
    return () => {}
  })
  await call('agentSession.subscribe', { sessionId: SESSION }, client)
  expect(input?.boundedFrames === true).toBe(bounded)
  expect(input?.snapshotCatchUp).toBe(snapshot)
  const request = { sessionId: SESSION, direction: 'after', cursor: { epoch: 'e', sequence: 1 } }
  await call('agentSession.history', request, client)
  const replaceHistory = snapshot && input?.readsCurrentRequests === true
  expect(hostCalls.history).toHaveBeenCalledWith(request, undefined, replaceHistory)
})

it('allows the local desktop renderer to replace a missed gap with a snapshot', async () => {
  let input: AgentSessionSubscribeInput | undefined
  hostCalls.subscribe.mockImplementation((opened: AgentSessionSubscribeInput) => {
    input = opened
    opened.emit({ type: 'end' })
    return () => {}
  })
  const cursor = { epoch: 'epoch-a', sequence: 10 }
  await call(
    'agentSession.subscribe',
    { sessionId: SESSION, cursor },
    {
      clientId: 'desktop-renderer',
      clientKind: 'runtime',
      clientCapabilities: [...DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES]
    }
  )
  expect(input?.cursor).toEqual(cursor)
  expect(input?.snapshotCatchUp).toBe(true)
})

describe('agentSession.conversationOutline', () => {
  it('derives the outline from the host journal on each request', async () => {
    hostCalls.journalSnapshot.mockReturnValueOnce({
      sessionId: SESSION,
      cursor: { epoch: 'epoch-a', sequence: 12 },
      items: [
        {
          itemId: 'prompt-1',
          revision: 1,
          sequence: 4,
          observedAt: 4,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Fix it' }] }
        },
        {
          itemId: 'reply-1',
          revision: 1,
          sequence: 5,
          observedAt: 5,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Done' }] }
        }
      ],
      submissions: []
    })

    const response = await call(
      'agentSession.conversationOutline',
      { sessionId: SESSION },
      STRUCTURED_CLIENT
    )

    expect(hostCalls.journalSnapshot).toHaveBeenCalledWith(SESSION)
    expect(response).toMatchObject({
      ok: true,
      result: {
        sessionId: SESSION,
        cursor: { epoch: 'epoch-a', sequence: 12 },
        entries: [{ itemId: 'prompt-1', sequence: 4, preview: 'Fix it', imageCount: 0 }],
        omittedEntries: 0
      }
    })
  })

  it('refuses a client that never negotiated structured sessions', async () => {
    const response = await call(
      'agentSession.conversationOutline',
      { sessionId: SESSION },
      { clientKind: 'runtime', clientCapabilities: [] }
    )
    expect(response).toMatchObject({ ok: false })
    expect(hostCalls.journalSnapshot).not.toHaveBeenCalled()
  })
})

describe('agentSession.item', () => {
  it('returns a whole output that every other read sends a head of', async () => {
    const output = 'z'.repeat(64 * 1024)
    const item = {
      itemId: 'tool-1',
      revision: 2,
      sequence: 7,
      observedAt: 7,
      body: {
        kind: 'tool-call',
        name: 'shell',
        input: { command: 'cat big.log' },
        state: 'completed',
        output: { head: output, byteLength: output.length, digest: 'd', truncated: false }
      }
    }
    hostCalls.journalSnapshot.mockReturnValueOnce({
      sessionId: SESSION,
      cursor: { epoch: 'epoch-a', sequence: 7 },
      items: [item],
      submissions: []
    })

    const response = await call(
      'agentSession.item',
      { sessionId: SESSION, itemId: 'tool-1' },
      STRUCTURED_MOBILE_CLIENT
    )

    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY)
    expect(response).toMatchObject({ ok: true, result: { item } })
  })
})

describe('options without a selected model across client versions', () => {
  const CURRENT_CLIENT = {
    ...STRUCTURED_CLIENT,
    clientCapabilities: [
      ...STRUCTURED_CLIENT.clientCapabilities,
      AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
    ]
  }

  const DESKTOP_CLIENTS = [
    ['local desktop', [...DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES]],
    ['paired desktop', remoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)]
  ] as const

  function missingModelReport() {
    const reader = new AcpStructuredOptions()
    reader.adoptSession(
      NewSessionResponseSchema.parse(
        JSON.parse(
          readFileSync(
            new URL('../../../acp/fixtures/omp-v17-windows-new-no-model.json', import.meta.url),
            'utf8'
          )
        )
      )
    )
    return reader.read()
  }

  it.each(['runtime', 'mobile'] as const)(
    'refuses the captured model-less report for an older %s client',
    async (clientKind) => {
      hostCalls.readOptions.mockResolvedValue(missingModelReport())
      const reply = await call(
        'agentSession.options',
        { sessionId: SESSION },
        {
          ...STRUCTURED_CLIENT,
          clientKind
        }
      )
      expect(reply).toMatchObject({
        ok: false,
        error: { message: 'structured_agent_session_unsupported' }
      })
      expect(reply).not.toHaveProperty('result')
      expect(hostCalls.readOptions).toHaveBeenCalledTimes(1)
    }
  )

  it.each(DESKTOP_CLIENTS)(
    'returns the captured absence to the %s',
    async (_name, capabilities) => {
      const report = missingModelReport()
      hostCalls.readOptions.mockResolvedValue(report)
      const reply = await call(
        'agentSession.options',
        { sessionId: SESSION },
        {
          clientKind: 'runtime',
          clientCapabilities: [...capabilities]
        }
      )
      expect(reply).toMatchObject({ id: 'request-1', ok: true, result: report })
      if (!reply.ok) {
        throw new Error('Updated desktops must receive the report')
      }
      expect(reply.result).toEqual(report)
      expect(reply).not.toHaveProperty('result.current.model')
    }
  )

  it('returns the captured absence to a phone that reads options without a model', async () => {
    const report = missingModelReport()
    hostCalls.readOptions.mockResolvedValue(report)
    const reply = await call(
      'agentSession.options',
      { sessionId: SESSION },
      { ...CURRENT_CLIENT, clientKind: 'mobile' }
    )
    expect(reply).toMatchObject({ ok: true, result: report })
    expect(reply).not.toHaveProperty('result.current.model')
  })

  it('keeps same-build in-process reads available', async () => {
    const report = missingModelReport()
    hostCalls.readOptions.mockResolvedValue(report)
    expect(await call('agentSession.options', { sessionId: SESSION })).toMatchObject({
      ok: true,
      result: report
    })
  })

  it.each(['reported-model', ''])(
    'preserves an existing string-valued report (%j)',
    async (model) => {
      const report = { models: [], current: { model, effort: 'off' } }
      hostCalls.readOptions.mockResolvedValue(report)
      for (const client of [STRUCTURED_CLIENT, CURRENT_CLIENT]) {
        expect(await call('agentSession.options', { sessionId: SESSION }, client)).toMatchObject({
          ok: true,
          result: report
        })
      }
    }
  )

  it('resumes legacy discovery after the provider reports a model', async () => {
    hostCalls.readOptions.mockResolvedValueOnce(missingModelReport())
    expect(
      await call('agentSession.options', { sessionId: SESSION }, STRUCTURED_CLIENT)
    ).toMatchObject({
      ok: false
    })
    const report = { models: [], current: { model: 'later-model', effort: 'off' } }
    hostCalls.readOptions.mockResolvedValueOnce(report)
    expect(
      await call('agentSession.options', { sessionId: SESSION }, STRUCTURED_CLIENT)
    ).toMatchObject({
      ok: true,
      result: report
    })
  })

  it('keeps authenticated capability input compatible with older parsers', () => {
    for (const [, capabilities] of DESKTOP_CLIENTS) {
      expect(parseRuntimeClientCapabilities(capabilities)).toEqual(capabilities)
      expect(capabilities).toContain(AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY)
    }
    expect(remoteRuntimeClientCapabilities()).not.toContain(
      AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
    )
  })
})

describe('legacy attach-shaped permission creation', () => {
  it.each(['agentSession.create', 'agentSession.ensure'] as const)(
    '%s gives a new record only the host permission seed',
    async (method) => {
      const seed = vi.fn(() => ({
        permissionMode: 'full-access',
        model: 'host-model',
        effort: 'high'
      }))
      const params = attachParams()
      expect(
        await call(method, params, STRUCTURED_CLIENT, {
          structuredAgentSessionLaunchSeedOptions: seed
        })
      ).toMatchObject({ ok: true })
      expect(hostCalls.attach.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          options: { permissionMode: 'full-access' },
          envelope: params.envelope
        })
      )
    }
  )
})

describe('prompt response parameters', () => {
  const rejects = async (method: string, params: unknown): Promise<void> => {
    const response = await call(method, params, STRUCTURED_CLIENT)
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  }

  it('accepts the maximum fully encoded Claude choice group and retains a finite bound', async () => {
    const maximumSelections = Array.from({ length: 4 }, (_, questionIndex) => ({
      questionId: `q${questionIndex + 1}`,
      optionIds: Array.from(
        { length: 4 },
        (_, optionIndex) => `q${questionIndex + 1}:choice-${optionIndex + 1}`
      )
    }))
    const optionId = `question-group:${encodeURIComponent(JSON.stringify(maximumSelections))}`
    expect(optionId.length).toBe(610)

    const response = await call(
      'agentSession.respondToQuestion',
      {
        envelope: envelope(),
        itemId: 'item-1',
        expectedRevision: 1,
        optionId
      },
      STRUCTURED_CLIENT
    )
    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.respondToPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ optionId })
    )

    await rejects('agentSession.respondToQuestion', {
      envelope: envelope(),
      itemId: 'item-1',
      expectedRevision: 1,
      optionId: 'x'.repeat(1025)
    })
  })

  it('takes a long typed answer as structured answers and bounds each field', async () => {
    const answers = [
      { questionId: 'q1', optionIds: ['q1:choice-1'] },
      { questionId: 'q2', optionIds: [], other: 'Proceed with the replacement. '.repeat(100) }
    ]
    const response = await call(
      'agentSession.respondToQuestion',
      { envelope: envelope(), itemId: 'item-1', expectedRevision: 1, answers },
      STRUCTURED_CLIENT
    )
    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.respondToPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'question', answers })
    )

    const base = { envelope: envelope(), itemId: 'item-1', expectedRevision: 1 }
    await rejects('agentSession.respondToQuestion', base)
    await rejects('agentSession.respondToQuestion', { ...base, optionId: 'q1:choice-1', answers })
    await rejects('agentSession.respondToQuestion', {
      ...base,
      answers: [{ questionId: 'q1', optionIds: [], other: 'x'.repeat(64 * 1024 + 1) }]
    })
    await rejects('agentSession.respondToQuestion', {
      ...base,
      answers: [{ questionId: 'q1', optionIds: [], other: 'é'.repeat(40 * 1024) }]
    })
    await rejects('agentSession.respondToApproval', { ...base, answers })
    await rejects('agentSession.respondToApproval', { ...base, optionId: 'x'.repeat(1025) })
  })

  it('takes a question id exactly as the agent wrote it, including edge spaces', async () => {
    const answers = [{ questionId: 'scope ', optionIds: [], other: 'mine' }]
    const response = await call(
      'agentSession.respondToQuestion',
      { envelope: envelope(), itemId: 'item-1', expectedRevision: 1, answers },
      STRUCTURED_CLIENT
    )
    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.respondToPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'question', answers })
    )
  })
})

describe('agentSession.send reply timing', () => {
  it('holds a pending reply until handover for a client that cannot show a later rejection', async () => {
    hostCalls.send.mockResolvedValueOnce(pendingSendResult())
    hostCalls.waitForSendSettlement.mockResolvedValueOnce(undefined)

    await call('agentSession.send', sendParams(), STRUCTURED_CLIENT)

    expect(hostCalls.waitForSendSettlement).toHaveBeenCalledWith(SESSION, 'client-1', {
      until: 'handed-over-or-behind-command',
      budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS
    })
  })

  it('answers at acceptance for the local desktop and paired desktop clients (W2)', async () => {
    for (const clientCapabilities of [
      DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES,
      // A paired desktop gains the structured surface as its own capability; the reply rule rides
      // on the list it already sends.
      [...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES, STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    ]) {
      hostCalls.send.mockResolvedValueOnce(pendingSendResult())
      const response = await call('agentSession.send', sendParams(), {
        clientKind: 'runtime',
        clientCapabilities: [...clientCapabilities]
      })
      expect(response).toMatchObject({
        ok: true,
        result: { value: { submission: { dispatchState: 'pending' } } }
      })
    }
    expect(hostCalls.waitForSendSettlement).not.toHaveBeenCalled()
  })

  it('keeps an old phone image send immediate and never recovers its interrupted send as a hidden card', async () => {
    const rig = await createQueuedMessageTestRig()
    hostCalls.send.mockImplementation(rig.host.send.bind(rig.host))
    const imageSend = () => {
      const body = hostTestMessage('from an old phone')
      body.blocks.push({ type: 'image-ref', path: '/tmp/shot.png' })
      const fields = { body, delivery: 'queue-if-active' as const }
      const id = hostTestOperationId()
      return { id, request: { envelope: rig.envelope(fields, 'agentSession.send', id), ...fields } }
    }
    let release = () => {}
    try {
      const working = await rig.workingSend()
      const image = imageSend()
      expect(
        await call('agentSession.send', image.request, STRUCTURED_MOBILE_CLIENT)
      ).toMatchObject({
        ok: true,
        result: { value: { submission: { clientMessageId: image.id } } }
      })
      expect(await rig.drafts()).toEqual([])
      await rig.settleAccepted(working, 'working')
      await eventually(async () => {
        expect((await rig.submission(image.id))?.handedOverAt).toBeDefined()
        expect(
          rig.dispatch.mock.calls.find(([input]) => input.clientMessageId === image.id)?.[0].body
        ).toEqual(image.request.body)
      })
      await rig.settleAccepted(image.id, 'image')

      const hold = holdDelivery()
      release = hold.release
      const interrupted = imageSend()
      expect(
        await call('agentSession.send', interrupted.request, STRUCTURED_MOBILE_CLIENT)
      ).toMatchObject({ ok: true, result: { value: { submission: expect.anything() } } })
      await hold.held
      const closed = rig.host.close(HOST_SESSION, 'user-close')
      release()
      await closed
      rig.crashRestartHostProcess()
      expect(await rig.drafts()).toEqual([])
      expect(await rig.submission(interrupted.id)).toMatchObject({
        source: { kind: 'user' },
        dispatchState: 'rejected'
      })
      expect(await rig.submission(interrupted.id)).not.toHaveProperty('keptAsQueuedMessageId')
    } finally {
      release()
      await rig.dispose()
    }
  })
})

function pendingSendResult() {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-a', sequence: 1 },
    value: {
      clientMessageId: 'client-1',
      submission: {
        clientMessageId: 'client-1',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending' as const,
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null,
        handoverRecorded: true as const
      }
    }
  }
}

describe('agentSession.subscribeTurnCompletions', () => {
  const subscribed = () => hostCalls.subscribeTurnCompletions.mock.calls.map(([sub]) => sub)

  it('opts a client into prompt edges only when it asks', async () => {
    await openStream('agentSession.subscribeTurnCompletions', {}, STRUCTURED_CLIENT)
    await openStream(
      'agentSession.subscribeTurnCompletions',
      { includePrompts: true },
      STRUCTURED_CLIENT
    )
    expect(subscribed().map((sub) => sub.includePrompts)).toEqual([false, true])
  })

  it("ignores a newer client's opt-in it does not know rather than refusing the stream", async () => {
    const replies = await openStream(
      'agentSession.subscribeTurnCompletions',
      { includePrompts: true, includeSomethingNewer: true },
      STRUCTURED_CLIENT
    )
    expect(replies.filter((reply) => !reply.ok)).toEqual([])
    expect(subscribed().map((sub) => sub.includePrompts)).toEqual([true])
  })
})
