import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CustomAcpAgentsConfig } from './custom-acp-agent-config'
import { customAcpLaunchSpec } from './custom-acp-launch-specs'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './acp-structured-adapter.test-support'
import {
  closeProviderTimelineRigs,
  messageText,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'

afterEach(closeProviderTimelineRigs)

function spec() {
  return customAcpLaunchSpec(
    CustomAcpAgentsConfig.parse({
      apiVersion: 1,
      agents: [
        {
          id: 'custom-reviewer',
          command: 'review-adapter',
          account: { variable: 'REVIEWER_HOME', directory: join(tmpdir(), 'reviewer-account') }
        }
      ]
    }).agents[0]!
  )
}

describe('a user-configured ACP adapter in native chat', () => {
  it('streams into the shared journal, completes a turn, and reopens the same provider session', async () => {
    const rig = await openAcpAdapterRig({ spec: spec() })
    await rig.acquire()
    expect(rig.started().link?.handle).toMatchObject({
      transport: 'acp',
      agent: 'custom-reviewer',
      nativeId: PROVIDER_SESSION
    })
    await sendHello(rig, 'custom-send')
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Review complete' }
      }
    })
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await waitFor(async () => {
      const rows = await rig.rig.rows()
      expect(rows.flatMap((row) => messageText(row.body))).toContain('Review complete')
      expect(rows.flatMap((row) => readAgentJournalTurn(row.body) ?? []).at(-1)).toMatchObject({
        state: 'completed'
      })
    })
    await rig.adapter.closeSession(SESSION)
    const reopened = await openAcpAdapterRig({
      spec: spec(),
      launch: {
        resume: {
          sessionId: PROVIDER_SESSION,
          key: 'acp/custom-reviewer:saved',
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        }
      }
    })
    await reopened.acquire({ fence: 2 })
    expect(reopened.sent('session/load')[0]?.params).toMatchObject({ sessionId: PROVIDER_SESSION })
    expect(reopened.started().link).toMatchObject({
      origin: 'resumed',
      handle: { agent: 'custom-reviewer', nativeId: PROVIDER_SESSION }
    })
    await reopened.adapter.closeAll()
  })

  it('keeps approval human-controlled and cancels an open permission when Stop is pressed', async () => {
    const rig = await openAcpAdapterRig({ spec: spec() })
    await rig.acquire({ permissionMode: 'ask' })
    await sendHello(rig, 'needs-approval')
    const prompt = await rig.frame('session/prompt')
    const agent = rig.child().agent
    const permission = agent.request(7, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'custom-tool-1', title: 'Write file' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    })
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    await rig.settle()
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'approval')).toBe(true)
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    expect(await permission).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    await rig.adapter.closeAll()
  })
})
