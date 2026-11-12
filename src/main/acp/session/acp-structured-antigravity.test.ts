import type { AntigravityChatAuthConfig } from '../../../shared/antigravity-chat-auth-config'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from '../fixtures/antigravity-v1.4.1-options.json'
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

async function rulesWorkspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-agy-meta-'))
  onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'AGENTS.md'), 'WORKSPACE_RULE')
  return {
    cwd,
    env: { HOME: cwd, USERPROFILE: cwd, GEMINI_HOME: join(cwd, 'managed'), PATH: '/usr/bin' }
  }
}

const rulesSpec = {
  ...ANTIGRAVITY,
  sessionMeta: { antigravity: { disabledTools: ['test-tool'] }, other: { keep: true } }
}
const expectedMeta = (rule: string) => ({
  antigravity: {
    disabledTools: ['test-tool'],
    systemPrompt: { append: expect.stringContaining(rule) }
  },
  other: { keep: true }
})

it.each(['load', 'resume'] as const)(
  'refreshes rules when %s reopens a process and preserves metadata through fallback new',
  async (method) => {
    const launch = await rulesWorkspace()
    let failRestore = false
    const rig = await openAcpAdapterRig({
      spec: { ...rulesSpec, resumePreference: method === 'resume' ? 'resume' : undefined },
      initialize: fixture.initialize,
      launch: {
        ...launch,
        resume: {
          sessionId: PROVIDER_SESSION,
          key: 'acp:antigravity:saved',
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        }
      },
      script: (agent) => {
        agent.confirmConfigOptions(fixture.session.configOptions)
        agent.on(`session/${method}`, (frame) =>
          failRestore
            ? agent.fail(frame, -32603, 'Session file unavailable')
            : agent.reply(frame, { ...fixture.session, sessionId: PROVIDER_SESSION })
        )
        agent.on('session/new', (frame) =>
          agent.reply(frame, { ...fixture.session, sessionId: PROVIDER_SESSION })
        )
      }
    })
    await rig.acquire()
    expect(rig.openVerdict()).toBeUndefined()
    expect(rig.sent(`session/${method}`)[0]?.params).toMatchObject({
      _meta: expectedMeta('WORKSPACE_RULE')
    })
    await rig.adapter.closeSession(SESSION)
    await writeFile(join(launch.cwd, 'AGENTS.md'), 'REFRESHED_RULE')
    failRestore = true
    await rig.acquire({ fence: 2 })
    expect(rig.openVerdict()).toBeUndefined()
    expect(rig.started().link?.origin).toBe('created')
    expect(rig.sent(`session/${method}`)[0]?.params).toMatchObject({
      _meta: expectedMeta('REFRESHED_RULE')
    })
    expect(rig.sent('session/new')[0]?.params).toMatchObject({
      _meta: expectedMeta('REFRESHED_RULE')
    })
  }
)

it('keeps managed rules on both attempts around authentication', async () => {
  const rig = await openAcpAdapterRig({
    spec: rulesSpec,
    initialize: fixture.initialize,
    launch: await rulesWorkspace(),
    script: (agent) => {
      agent.confirmConfigOptions(fixture.session.configOptions)
      agent.on('session/new', (frame) =>
        agent.frames.some((sent) => sent.method === 'authenticate')
          ? agent.reply(frame, { ...fixture.session, sessionId: PROVIDER_SESSION })
          : agent.fail(frame, -32000, 'Authentication required')
      )
      agent.on('authenticate', (frame) => agent.reply(frame, {}))
    }
  })
  await rig.acquire()
  expect(rig.openVerdict()).toBeUndefined()
  expect(rig.sent('session/new').map((frame) => frame.params)).toEqual([
    expect.objectContaining({ _meta: expectedMeta('WORKSPACE_RULE') }),
    expect.objectContaining({ _meta: expectedMeta('WORKSPACE_RULE') })
  ])
})

it('cancels activation metadata with the open signal after acquisition has ended', async () => {
  const entered = Promise.withResolvers<AbortSignal | undefined>()
  const release = Promise.withResolvers<void>()
  const rig = await openAcpAdapterRig({
    spec: {
      ...ANTIGRAVITY,
      resolveSessionMeta: async ({ signal }) => {
        entered.resolve(signal)
        await release.promise
        signal?.throwIfAborted()
        return undefined
      }
    }
  })
  const acquired = await rig.acquire({ waitForStart: false })
  const controller = new AbortController()
  const opening = rig.adapter
    .open({
      sessionId: SESSION,
      fence: 1,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: controller.signal
    })
    .catch(() => undefined)
  const signal = await entered.promise
  controller.abort()
  release.resolve()
  await opening
  expect(signal?.aborted).toBe(true)
  expect(rig.sent('session/new')).toHaveLength(0)
})

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
