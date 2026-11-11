import type { AntigravityChatAuthConfig } from '../../../shared/antigravity-chat-auth-config'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './testing/acp-structured-adapter.test-support'
import { GrokFixtureReplay } from './testing/acp-structured-fixture-replay.test-support'
import {
  readAcpFixture,
  type AcpFixtureFrame
} from '../timeline/testing/acp-timeline-fixture.test-support'

const ANTIGRAVITY = acpLaunchSpecFor('antigravity')!
const result = (frame: AcpFixtureFrame | undefined) =>
  z.record(z.string(), z.unknown()).parse(frame?.message.result)
afterEach(closeProviderTimelineRigs)

it.each<{ config: AntigravityChatAuthConfig | undefined; method: string }>([
  {
    config: {
      method: 'oauth-business',
      gcpProject: 'enterprise-project',
      gcpLocation: 'us-central1'
    },
    method: 'oauth-business'
  }
])(
  'signs a first chat in with $method, asks in default mode, and answers a question',
  async ({ config, method }) => {
    const [initialized, opened, ...turn] = await readAcpFixture('antigravity-v1-question')
    const replay = new GrokFixtureReplay(turn)
    const rig = await openAcpAdapterRig({
      spec: ANTIGRAVITY,
      launch: { antigravityChatAuth: config },
      initialize: result(initialized),
      script: (agent) => {
        replay.attach(agent)
        // The recorded server requires explicit authentication even with a fresh folder.
        agent.on('session/new', (frame) =>
          agent.frames.some((sent) => sent.method === 'authenticate')
            ? agent.reply(frame, { ...result(opened), sessionId: PROVIDER_SESSION })
            : agent.fail(frame, -32000, 'Authentication required')
        )
        agent.on('authenticate', (frame) => agent.reply(frame, {}))
      }
    })
    await rig.acquire()
    expect(rig.sent('authenticate')[0]?.params).toEqual({ methodId: method })
    expect(rig.sent('session/set_config_option')[0]?.params).toMatchObject({ value: 'default' })
    await sendHello(rig, 'send-1')
    const question = await waitFor(async () => {
      const found = (await rig.rig.rows()).find((row) => row.body.kind === 'question')
      expect(found && replay.awaiting).toBe('reply')
      return found!
    })
    expect(question.body).toMatchObject({ options: [{ label: 'red' }, { id: '2', label: 'blue' }] })
    await rig.adapter.answerPrompt({
      sessionId: SESSION,
      itemId: question.itemId,
      kind: 'question',
      response: { kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['2'] }] },
      fence: 1,
      commit: async () => {}
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    const reply = rig.child().agent.frames.find((frame) => !frame.method && frame.id === 2)
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: '2' } })
    await waitFor(async () =>
      expect((await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toEqual(
        [expect.objectContaining({ state: 'completed', outcome: 'success' })]
      )
    )
  }
)

it("leaves a Full access host chat's plan approval to the person", async () => {
  let answered = false
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY.hostBackend!.spec,
    launch: { args: ['acp', '--dangerously-skip-permissions'], fullAccess: true },
    script: (agent) =>
      agent.on('session/prompt', () => {
        // agy's flag does not approve plans, so it still asks.
        void agent
          .request('plan', 'session/request_permission', {
            sessionId: PROVIDER_SESSION,
            toolCall: { toolCallId: 'plan-1', title: 'Approve plan' },
            options: [{ optionId: 'proceed', name: 'Proceed', kind: 'allow_once' }]
          })
          .then(() => {
            answered = true
          })
      })
  })
  await rig.acquire({ permissionMode: 'full-access' })
  await sendHello(rig, 'send-1')
  await waitFor(async () =>
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'approval')).toBe(true)
  )
  expect(answered).toBe(false)
})

it('stops a chat that has left the gate but is not loaded yet before the operation runs', async () => {
  const [initialized, opened] = await readAcpFixture('antigravity-v1-question')
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
    initialize: result(initialized),
    script: (agent) =>
      agent.on('session/new', (frame) =>
        agent.reply(frame, { ...result(opened), sessionId: PROVIDER_SESSION })
      )
  })
  // Acquisition ended, but no loaded chat owns this child yet.
  await rig.acquire()
  const child = rig.child()
  let ranOverLiveChild: boolean | null = null
  await ANTIGRAVITY.launchGate!.run(
    async () => {},
    async () => {
      ranOverLiveChild = !child.exited
    }
  )
  expect(ranOverLiveChild).toBe(false)
})
