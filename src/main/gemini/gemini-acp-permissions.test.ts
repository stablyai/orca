import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from '../acp/acp-structured-adapter.test-support'
import {
  GEMINI_ACP_INITIALIZE,
  GEMINI_ACP_PERMISSION,
  GEMINI_ACP_TOOL,
  scriptGeminiAcpSession
} from './gemini-acp.test-fixture'

afterEach(closeProviderTimelineRigs)
const GEMINI = acpLaunchSpecFor('gemini')!

describe('original Gemini tool permissions and cancellation', () => {
  it.each(['proceed_once', 'cancel'])(
    'answers the original option ID %s and keeps tool output',
    async (optionId) => {
      let permissionReply: unknown
      const rig = await openAcpAdapterRig({
        spec: GEMINI,
        initialize: GEMINI_ACP_INITIALIZE,
        script: (agent) => {
          scriptGeminiAcpSession(agent)
          agent.on('session/prompt', (frame) => {
            agent.notify('session/update', {
              sessionId: PROVIDER_SESSION,
              update: { sessionUpdate: 'tool_call', ...GEMINI_ACP_TOOL }
            })
            void agent
              .request(700, 'session/request_permission', GEMINI_ACP_PERMISSION)
              .then((reply) => {
                permissionReply = reply.result
                agent.notify('session/update', {
                  sessionId: PROVIDER_SESSION,
                  update: {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: GEMINI_ACP_TOOL.toolCallId,
                    status: optionId === 'cancel' ? 'failed' : 'completed',
                    content: [
                      {
                        type: 'content',
                        content: {
                          type: 'text',
                          text: optionId === 'cancel' ? 'Tool was canceled by the user.' : 'fixture'
                        }
                      }
                    ]
                  }
                })
                agent.reply(frame, { stopReason: 'end_turn' })
              })
          })
        }
      })
      await rig.acquire()
      await sendHello(rig, 'tool-1')
      const approval = await waitFor(async () => {
        const row = (await rig.rig.rows()).find((row) => row.body.kind === 'approval')
        if (!row) {
          throw new Error('approval pending')
        }
        return row
      })
      expect(permissionReply).toBeUndefined()
      await rig.adapter.answerPrompt({
        sessionId: SESSION,
        itemId: approval.itemId,
        kind: 'approval',
        response: { kind: 'option', optionId },
        fence: 1,
        commit: async () => {}
      })
      await waitFor(() =>
        expect(permissionReply).toEqual({ outcome: { outcome: 'selected', optionId } })
      )
      await waitFor(async () =>
        expect(
          (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
        ).toMatchObject([{ state: 'completed', outcome: 'success' }])
      )
      expect(
        (await rig.rig.rows()).find((row) => row.body.kind === 'tool-call')?.body
      ).toMatchObject({
        name: 'printf fixture',
        state: optionId === 'cancel' ? 'failed' : 'completed',
        input: null,
        output: {
          head: optionId === 'cancel' ? 'Tool was canceled by the user.' : 'fixture',
          truncated: false
        }
      })
    }
  )

  it('grants Full access using the runtime allow-once option rather than persisting Always allow', async () => {
    let permissionReply: unknown
    const rig = await openAcpAdapterRig({
      spec: GEMINI,
      initialize: GEMINI_ACP_INITIALIZE,
      launch: { fullAccess: true },
      script: (agent) => {
        scriptGeminiAcpSession(agent)
        agent.on('session/prompt', (frame) => {
          void agent
            .request(700, 'session/request_permission', GEMINI_ACP_PERMISSION)
            .then((reply) => {
              permissionReply = reply.result
              agent.reply(frame, { stopReason: 'end_turn' })
            })
        })
      }
    })
    await rig.acquire({ permissionMode: 'full-access' })
    await sendHello(rig, 'tool-1')
    await waitFor(() =>
      expect(permissionReply).toEqual({
        outcome: { outcome: 'selected', optionId: 'proceed_once' }
      })
    )
    expect((await rig.rig.rows()).filter((row) => row.body.kind === 'approval')).toEqual([])
  })

  it('cancels the ACP prompt and pending tool approval without inventing successful completion', async () => {
    let permissionReply: unknown
    const rig = await openAcpAdapterRig({
      spec: GEMINI,
      initialize: GEMINI_ACP_INITIALIZE,
      script: (agent) => {
        scriptGeminiAcpSession(agent)
        agent.on('session/prompt', (frame) => {
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: { sessionUpdate: 'tool_call', ...GEMINI_ACP_TOOL }
          })
          void agent
            .request(700, 'session/request_permission', GEMINI_ACP_PERMISSION)
            .then((reply) => {
              permissionReply = reply.result
            })
          agent.on('session/cancel', () => agent.reply(frame, { stopReason: 'cancelled' }))
        })
      }
    })
    await rig.acquire()
    await sendHello(rig, 'cancel-1')
    await waitFor(async () =>
      expect((await rig.rig.rows()).some((row) => row.body.kind === 'approval')).toBe(true)
    )
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    expect((await rig.frame('session/cancel')).params).toMatchObject({
      sessionId: PROVIDER_SESSION
    })
    await waitFor(() => expect(permissionReply).toEqual({ outcome: { outcome: 'cancelled' } }))
    await waitFor(async () =>
      expect(
        (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      ).toMatchObject([{ state: 'interrupted', outcome: 'cancellation' }])
    )
  })
})
