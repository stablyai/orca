import '../unused-default-rpc-methods.test-fixture'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { AGENT_SESSION_SNAPSHOT_CATCH_UP_CLIENT_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../../../shared/agent-session/requests/agent-session-current-requests-capability'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { AcpStructuredOptions } from '../../../acp/acp-structured-options'
import { NewSessionResponseSchema } from '../../../acp/generated/acp-protocol.generated'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import type { AgentSessionSubscribeInput } from '../../../native-chat/agent-session-wire/structured-agent-session-subscribers'
import {
  attachParams,
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER
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

describe('options without a selected model across client versions', () => {
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
    'labels the captured model-less report for an older %s client',
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
        ok: true,
        result: {
          current: { model: '' },
          models: [{ id: '', label: 'Model not reported', isDefault: false, efforts: [] }]
        }
      })
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
      const compactId = hostTestOperationId()
      const compactFields = { command: 'compact' as const, delivery: 'queue-if-active' as const }
      expect(
        await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
          ...compactFields,
          envelope: rig.envelope(compactFields, 'agentSession.conversationCommand', compactId),
          userSend: true
        })
      ).toMatchObject({ ok: true, value: { queued: { messageId: compactId } } })
      const image = imageSend()
      expect(
        await call('agentSession.send', image.request, STRUCTURED_MOBILE_CLIENT)
      ).toMatchObject({
        ok: true,
        result: { value: { submission: { clientMessageId: image.id } } }
      })
      expect((await rig.drafts()).map((card) => card.messageId)).toEqual([compactId])
      expect((await rig.submission(image.id))?.handedOverAt).toBeUndefined()
      await rig.settleAccepted(working, 'working')
      await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
      expect((await rig.submission(image.id))?.handedOverAt).toBeUndefined()
      rig.finishCompact()
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
