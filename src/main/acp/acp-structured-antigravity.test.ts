import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './acp-structured-adapter.test-support'
import { GrokFixtureReplay } from './acp-structured-fixture-replay.test-support'
import { framesOf, launch, openHostRig, RESUMES, send } from './acp-structured-host.test-support'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { deferred } from './acp-scripted-agent.test-support'
import { resolveAcpLaunchInvocation } from './acp-structured-launch-resolution'
import { readAcpFixture, type AcpFixtureFrame } from './acp-timeline-fixture.test-support'

const ANTIGRAVITY = acpLaunchSpecFor('antigravity')!
const result = (frame: AcpFixtureFrame | undefined) =>
  z.record(z.string(), z.unknown()).parse(frame?.message.result)
afterEach(closeProviderTimelineRigs)

it('signs a first chat in, asks in default mode, and answers a question with one of its choices', async () => {
  const [initialized, opened, ...turn] = await readAcpFixture('antigravity-v1-question')
  const replay = new GrokFixtureReplay(turn)
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
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
  expect(rig.sent('authenticate')[0]?.params).toEqual({ methodId: 'oauth-personal' })
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
    expect((await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toEqual([
      expect.objectContaining({ state: 'completed', outcome: 'success' })
    ])
  )
})

it('launches on its own private folder with file sign-in and no other Google credentials', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'orca-antigravity-'))
  onTestFinished(() => rm(stateDirectory, { recursive: true, force: true }))
  const folder = join(stateDirectory, 'antigravity-chat')
  const user = {
    GEMINI_HOME: '/data/.gemini',
    GOOGLE_API_KEY: 'k',
    AGY_ACP_FORCE_FILE_STORAGE: '0'
  }
  const home = await ANTIGRAVITY.account.resolve({ launchEnv: user, stateDirectory })
  const { command, env, envToDelete } = await resolveAcpLaunchInvocation(ANTIGRAVITY, home, {
    resolveEnvironment: async () => ({ ...user, PATH: '' }),
    resolveCommandSettings: () => ({ agentCmdOverrides: { antigravity: '/missing/agy' } }),
    inheritedEnv: { GEMINI_API_KEY: 'k', ANTIGRAVITY_HARNESS_PATH: '/x', GCLOUD_PROJECT: 'p' },
    dataDirectory: stateDirectory
  })
  expect(command).toBe(ANTIGRAVITY.command)
  expect(env).toMatchObject({ GEMINI_HOME: folder, AGY_ACP_FORCE_FILE_STORAGE: '1' })
  // Spawn deletions override overlays; preserve the file sign-in keys.
  expect(envToDelete.sort()).toEqual([
    'ANTIGRAVITY_HARNESS_PATH',
    'GCLOUD_PROJECT',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY'
  ])
  await ANTIGRAVITY.account.prepare?.(env)
  const modes = [folder, join(folder, 'antigravity-acp')].map(
    async (path) => (await stat(path)).mode
  )
  for (const mode of await Promise.all(modes)) {
    expect(process.platform === 'win32' || (mode & 0o777) === 0o700).toBe(true)
  }
})

it('runs the chat permission mode picked mid-chat as the server mode on the next send', async () => {
  let resumed = false
  const { rig, host, fence, ready } = await openHostRig({
    spec: ANTIGRAVITY,
    initialize: RESUMES,
    script: (agent) => {
      agent.on('session/resume', (frame) => agent.reply(frame, {}))
      agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    },
    deps: {
      resolveLaunch: async () => ({
        ...(await launch(() => resumed, ANTIGRAVITY)()),
        env: { GEMINI_HOME: join(tmpdir(), 'antigravity-chat') }
      })
    }
  })
  const attach = hostTestAttachParams(null, {
    provider: 'antigravity',
    agent: 'antigravity',
    accountHome: { variable: 'GEMINI_HOME', path: '/data/antigravity-chat' },
    providerHandle: undefined
  })
  expect(await host.attach(CALLER, attach)).toMatchObject({ ok: true })
  await ready()
  resumed = true
  const modes: unknown[] = []
  let child = rig.child()
  for (const value of ['accept-edits', 'full-access']) {
    const fields = { key: 'permissionMode', value }
    const fingerprint = { method: 'agentSession.setOption', sessionId: HOST_TEST_SESSION, fields }
    const envelope = {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence(),
      payloadFingerprint: computeAgentSessionPayloadFingerprint(fingerprint)
    }
    expect(await host.setOption(CALLER, { envelope, ...fields })).toMatchObject({ ok: true })
    await send(host, value)
    const previous = child
    child = await waitFor(() => {
      expect(rig.child()).not.toBe(previous)
      expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(1)
      return rig.child()
    })
    modes.push(framesOf(child, 'session/set_config_option')[0]?.params)
  }
  expect(modes).toEqual([
    expect.objectContaining({ configId: 'mode', value: 'auto_edit' }),
    expect.objectContaining({ configId: 'mode', value: 'yolo' })
  ])
})

it('refuses a new start while its sign-in changes, and stops one already starting', async () => {
  const gate = ANTIGRAVITY.launchGate!
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
    script: (agent) => agent.on('session/new', () => {})
  })
  const starting = rig.acquire()
  await rig.frame('session/new')
  const signIn = deferred<void>()
  onTestFinished(() => signIn.resolve())
  const operation = gate.run(
    async () => {},
    () => signIn.promise
  )
  await starting
  expect(rig.openFailure()).toMatchObject({ name: 'AcpConnectionClosedError' })
  expect(rig.child().exited).toBe(true)
  await expect(rig.acquire()).rejects.toMatchObject({ reason: 'accountSwitchInProgress' })
  signIn.resolve()
  await operation

  const lateStart = gate.enter(undefined)
  let left = false
  onTestFinished(() => {
    left = true
    lateStart.leave()
  })
  let stopped = false
  let worked = false
  const failedOperation = gate.run(
    async () => {
      expect(left).toBe(true)
      stopped = true
      throw new Error('stop failed')
    },
    async () => {
      worked = true
    }
  )
  void failedOperation.catch(() => {})
  expect(lateStart.signal.aborted).toBe(true)
  expect(stopped).toBe(false)
  left = true
  lateStart.leave()
  await expect(failedOperation).rejects.toThrow('stop failed')
  expect(worked).toBe(false)
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
