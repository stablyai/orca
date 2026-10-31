import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  messageText,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from '../acp/acp-structured-adapter.test-support'
import { GEMINI_ACP_INITIALIZE, scriptGeminiAcpSession } from './gemini-acp.test-fixture'

afterEach(closeProviderTimelineRigs)
const GEMINI = acpLaunchSpecFor('gemini')!

describe('original Gemini ACP native session', () => {
  it('creates on the original protocol, reads runtime models and writes its legacy model option', async () => {
    const rig = await openAcpAdapterRig({
      spec: GEMINI,
      initialize: GEMINI_ACP_INITIALIZE,
      script: scriptGeminiAcpSession
    })
    await rig.acquire()
    expect(rig.started().link).toMatchObject({
      handle: { transport: 'acp', agent: 'gemini', nativeId: PROVIDER_SESSION },
      origin: 'created'
    })
    expect(rig.sent('session/new')[0]?.params).toEqual({
      cwd: '/workspace/project',
      mcpServers: []
    })
    const options = await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })
    expect(options.acceptsImages).toBe(true)
    expect(options.models.map((model) => [model.id, model.efforts])).toEqual([
      ['runtime-default', []],
      ['runtime-alternate', []]
    ])
    await expect(
      rig.adapter.setOption({
        sessionId: SESSION,
        fence: 1,
        key: 'model',
        value: 'runtime-alternate'
      })
    ).resolves.toEqual({ model: 'runtime-alternate' })
    expect(rig.sent('session/set_model')[0]?.params).toEqual({
      sessionId: PROVIDER_SESSION,
      modelId: 'runtime-alternate'
    })
    await expect(
      rig.adapter.setOption({
        sessionId: SESSION,
        fence: 1,
        key: 'effort',
        value: 'high'
      })
    ).rejects.toThrow('offers no session option named effort')
    expect(rig.sent('session/set_config_option')).toEqual([])
    expect(rig.sent('authenticate')).toEqual([])
  })

  it('sends image bytes over ACP and journals streamed reasoning, reply and context usage', async () => {
    const image = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'image-ref', url: `data:image/png;base64,${image}` },
        { type: 'text', text: 'Describe this image' }
      ]
    }
    const rig = await openAcpAdapterRig({
      spec: GEMINI,
      initialize: GEMINI_ACP_INITIALIZE,
      script: (agent) => {
        scriptGeminiAcpSession(agent)
        agent.on('session/prompt', (frame) => {
          for (const [sessionUpdate, text] of [
            ['agent_thought_chunk', '**Image**\nInspecting the image'],
            ['agent_message_chunk', 'A fixture '],
            ['agent_message_chunk', 'image.']
          ]) {
            agent.notify('session/update', {
              sessionId: PROVIDER_SESSION,
              update: { sessionUpdate, content: { type: 'text', text } }
            })
          }
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: { sessionUpdate: 'usage_update', used: 30, size: 1000 }
          })
          agent.reply(frame, {
            stopReason: 'end_turn',
            usage: { inputTokens: 25, outputTokens: 5, totalTokens: 30 }
          })
        })
      }
    })
    await rig.acquire()
    await rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'image-1', body, fence: 1 })
    expect((await rig.frame('session/prompt')).params).toMatchObject({
      sessionId: PROVIDER_SESSION,
      prompt: [
        { type: 'image', mimeType: 'image/png', data: image },
        { type: 'text', text: 'Describe this image' }
      ]
    })
    await waitFor(async () =>
      expect(
        (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      ).toMatchObject([
        {
          state: 'completed',
          outcome: 'success',
          contextUsage: { window: { tokens: 1000 }, used: { usage: { inputTokens: 30 } } }
        }
      ])
    )
    const rows = await rig.rig.rows()
    expect(rows.flatMap((row) => messageText(row.body) ?? [])).toEqual([
      '**Image**\nInspecting the image',
      'A fixture image.'
    ])
    await rig.adapter.closeSession(SESSION)
    const reopened = await rig.rig.reopenJournal()
    expect(reopened.snapshot().items.filter((row) => row.body.kind === 'message')).toEqual(
      rows.filter((row) => row.body.kind === 'message')
    )
  })

  it('refuses image delivery when a future runtime no longer advertises it', async () => {
    const rig = await openAcpAdapterRig({
      spec: GEMINI,
      initialize: { ...GEMINI_ACP_INITIALIZE, agentCapabilities: { loadSession: true } },
      script: scriptGeminiAcpSession
    })
    await rig.acquire()
    const result = await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'image-1',
      fence: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', url: 'data:image/png;base64,iVBORw0KGgo=' }]
      }
    })
    expect(result).toMatchObject({ state: 'rejected', rejection: { kind: 'attachmentInvalid' } })
    expect(rig.sent('session/prompt')).toEqual([])
  })

  it('preserves signed-out startup without trying another authentication method or new session', async () => {
    const rig = await openAcpAdapterRig({
      spec: GEMINI,
      initialize: GEMINI_ACP_INITIALIZE,
      script: (agent) =>
        agent.on('session/new', (frame) =>
          agent.fail(frame, -32000, 'Gemini API key is missing or not configured.')
        )
    })
    await rig.acquire()
    expect(rig.openFailure()).toMatchObject({ reason: 'notSignedIn' })
    expect(rig.sent('session/new')).toHaveLength(1)
    expect(rig.sent('authenticate')).toEqual([])
  })

  it('classifies the original CLI numeric quota error without inventing a reset time', async () => {
    const rig = await openAcpAdapterRig({
      spec: GEMINI,
      initialize: GEMINI_ACP_INITIALIZE,
      script: (agent) => {
        scriptGeminiAcpSession(agent)
        agent.on('session/prompt', (frame) =>
          agent.fail(frame, 429, 'Rate limit exceeded. Try again later.')
        )
      }
    })
    await rig.acquire()
    await sendHello(rig, 'limited')
    await waitFor(async () =>
      expect(
        (await rig.rig.rows()).find(
          (row) => row.body.kind === 'status' && row.body.failure?.kind === 'usageLimitReached'
        )
      ).toBeDefined()
    )
  })
})
