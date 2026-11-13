import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { readCursorModelCatalog } from '../acp-dialects/cursor-model-catalog'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import type { AcpScriptedAgent } from '../process/testing/acp-scripted-agent.test-support'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './testing/acp-structured-adapter.test-support'

const CURSOR = acpLaunchSpecFor('cursor')!
afterEach(closeProviderTimelineRigs)

// Recorded from cursor-agent 2026.11.11 over `cursor-agent acp`, which names no session on these.
const QUESTION = {
  toolCallId: 'call-1\nfc_1',
  title: 'Preferences',
  questions: [
    {
      id: 'color',
      prompt: 'Which color?',
      options: [
        { id: 'red', label: 'Red' },
        { id: 'blue', label: 'Blue' }
      ],
      allowMultiple: false
    }
  ]
}
const QUESTION_FALLBACK = {
  sessionId: PROVIDER_SESSION,
  toolCall: { toolCallId: 'call-1\nfc_1_q0', title: 'Which color?', kind: 'other' },
  options: [
    { optionId: 'red', name: 'Red', kind: 'allow_once' },
    { optionId: 'blue', name: 'Blue', kind: 'allow_once' },
    { optionId: '__ask_question_skip__', name: 'Skip', kind: 'reject_once' }
  ]
}
const OPUS_OPTIONS: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'claude-opus-4-8',
    options: [
      { value: 'default', name: 'Auto' },
      { value: 'claude-opus-4-8', name: 'Claude Opus 4.8' }
    ]
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'true',
    options: [
      { value: 'false', name: 'Off' },
      { value: 'true', name: 'On' }
    ]
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
      { value: 'max', name: 'Max' }
    ]
  },
  {
    id: 'fast',
    name: 'Fast',
    category: 'model_config',
    type: 'select',
    currentValue: 'false',
    options: [
      { value: 'false', name: 'Off' },
      { value: 'true', name: 'Fast' }
    ]
  }
]

async function fullAccessRig(request: (agent: AcpScriptedAgent) => Promise<unknown>) {
  const replies: unknown[] = []
  const rig = await openAcpAdapterRig({
    spec: CURSOR,
    launch: { fullAccess: true },
    script: (agent) =>
      agent.on('session/prompt', () => {
        void request(agent).then((reply) => replies.push(reply))
      })
  })
  await rig.acquire({ permissionMode: 'full-access' })
  await sendHello(rig, 'send-1')
  return { rig, replies }
}

it("asks the person Cursor's question in Full access and answers it in Cursor's shape", async () => {
  const { rig, replies } = await fullAccessRig((agent) =>
    agent.request(7, 'cursor/ask_question', QUESTION)
  )
  const question = await waitFor(async () => {
    const found = (await rig.rig.rows()).find((row) => row.body.kind === 'question')
    expect(found).toBeDefined()
    return found!
  })
  expect(replies).toEqual([])
  await rig.adapter.answerPrompt({
    sessionId: SESSION,
    itemId: question.itemId,
    kind: 'question',
    response: { kind: 'answers', answers: [{ questionId: 'color', optionIds: ['blue'] }] },
    fence: 1,
    commit: async () => {}
  })
  await waitFor(() =>
    expect(replies).toEqual([
      expect.objectContaining({
        result: {
          outcome: {
            outcome: 'answered',
            answers: [{ questionId: 'color', selectedOptionIds: ['blue'] }]
          }
        }
      })
    ])
  )
})

it("never picks the first answer of Cursor's fallback question in Full access", async () => {
  const { rig, replies } = await fullAccessRig((agent) =>
    agent.request(8, 'session/request_permission', QUESTION_FALLBACK)
  )
  await waitFor(async () =>
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'question')).toBe(true)
  )
  expect(replies).toEqual([])
})

it("shows Cursor's plan and accepts it, which ends the turn without building", async () => {
  const { rig, replies } = await fullAccessRig((agent) =>
    agent.request(9, 'cursor/create_plan', {
      toolCallId: 'call-2\nfc_2',
      name: 'Add README.md',
      overview: 'Add a one-line README.md.',
      plan: '# Add README.md\n\nCreate README.md with one line.',
      todos: [],
      isProject: false,
      phases: []
    })
  )
  await waitFor(() =>
    expect(replies).toEqual([
      expect.objectContaining({ result: { outcome: { outcome: 'accepted' } } })
    ])
  )
  expect((await rig.rig.rows()).map((row) => row.body)).toContainEqual(
    expect.objectContaining({
      presentation: 'plan-document',
      text: '# Add README.md\n\nCreate README.md with one line.'
    })
  )
})

it('writes effort to the effort levels, not the thinking switch, and Fast to its own option', () => {
  const options = new AcpStructuredOptions(CURSOR.dialect)
  options.adoptSession({ configOptions: OPUS_OPTIONS }, 'new')
  expect(options.write('effort', 'max')).toEqual({
    method: 'config',
    configId: 'effort',
    value: 'max'
  })
  expect(options.write('fastMode', 'true')).toEqual({
    method: 'config',
    configId: 'fast',
    value: 'true'
  })
  expect(options.read().current).toMatchObject({
    model: 'claude-opus-4-8',
    effort: 'high',
    fastMode: false
  })
})

it("writes the person's Fast choice again after a model switch resets it", async () => {
  // Each model brings its own Fast default: Grok and Composer start on.
  const optionsFor = (model: string, fast: string): SessionConfigOption[] => [
    { ...OPUS_OPTIONS[0]!, currentValue: model } as SessionConfigOption,
    { ...OPUS_OPTIONS[3]!, currentValue: fast } as SessionConfigOption
  ]
  const rig = await openAcpAdapterRig({
    spec: CURSOR,
    script: (agent) => {
      let model = 'grok-4.7'
      let fast = 'true'
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: optionsFor(model, fast) })
      )
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = frame.params as { configId: string; value: string }
        if (configId === 'model') {
          model = value
          fast = 'true'
        } else {
          fast = value
        }
        agent.reply(frame, { configOptions: optionsFor(model, fast) })
      })
      agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    }
  })
  await rig.acquire()
  for (const [clientMessageId, model] of [
    ['send-1', 'grok-4.7'],
    ['send-2', 'composer-2.5']
  ] as const) {
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId,
      fence: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      executionOptions: { model, fastMode: 'false' }
    })
    await rig.settle()
  }
  expect(
    rig.sent('session/set_config_option').map(({ params }) => {
      const { configId, value } = params as { configId: string; value: string }
      return `${configId}=${value}`
    })
  ).toEqual(['model=grok-4.7', 'fast=false', 'model=composer-2.5', 'fast=false'])
})

it("lists each model's own effort levels and Fast default before a chat exists", async () => {
  const models = await readCursorModelCatalog({
    requestSessionFreeExtension: async (method) => {
      expect(method).toBe('cursor/list_available_models')
      return {
        models: [
          { value: 'default', name: 'Auto', configOptions: [] },
          {
            value: 'claude-opus-4-8',
            name: 'Claude Opus 4.8',
            configOptions: OPUS_OPTIONS.slice(1)
          },
          { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', configOptions: [] },
          {
            value: 'composer-2.5',
            name: 'Composer 2.5',
            configOptions: [{ ...OPUS_OPTIONS[3]!, currentValue: 'true' }]
          }
        ]
      }
    }
  })
  expect(models).toEqual([
    { id: 'default', label: 'Auto', isDefault: false, efforts: [], supportsFastMode: false },
    {
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      isDefault: false,
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
        { value: 'max', label: 'Max' }
      ],
      defaultEffort: 'high',
      supportsFastMode: true,
      defaultFastMode: false
    },
    {
      id: 'gemini-3.1-pro',
      label: 'Gemini 3.1 Pro',
      isDefault: false,
      efforts: [],
      supportsFastMode: false
    },
    {
      id: 'composer-2.5',
      label: 'Composer 2.5',
      isDefault: false,
      efforts: [],
      supportsFastMode: true,
      defaultFastMode: true
    }
  ])
})

it("drops Cursor's new-file markers from an edit's diff", () => {
  const update = CURSOR.dialect.normalizeToolUpdate!({
    toolCallId: 'call-3\nfc_3',
    status: 'completed',
    content: [
      {
        type: 'diff',
        path: '/tmp/cursor-ws/new.txt',
        oldText: '-- /dev/null',
        newText: '++ b//tmp/cursor-ws/new.txt\nhi'
      }
    ]
  })
  expect(update.content).toEqual([
    { type: 'diff', path: '/tmp/cursor-ws/new.txt', oldText: null, newText: 'hi' }
  ])
})

it("pins Cursor's own config folder, following XDG_CONFIG_HOME as Cursor does", async () => {
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
  vi.stubEnv('CURSOR_CONFIG_DIR', undefined)
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  const stateDirectory = '/state'
  expect(
    await CURSOR.account.resolve({ launchEnv: { HOME: '/home/ada' }, stateDirectory })
  ).toEqual({ variable: 'CURSOR_CONFIG_DIR', path: expect.stringMatching(/[\\/]\.cursor$/) })
  expect(
    await CURSOR.account.resolve({
      launchEnv: { XDG_CONFIG_HOME: '/home/ada/.config' },
      stateDirectory
    })
  ).toEqual({ variable: 'CURSOR_CONFIG_DIR', path: join('/home/ada/.config', 'cursor') })
})

it('closes a signed-out chat without opening a browser sign-in', async () => {
  const rig = await openAcpAdapterRig({
    spec: CURSOR,
    initialize: { authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }] },
    script: (agent) =>
      agent.on('session/new', (frame) => agent.fail(frame, -32000, 'Authentication required'))
  })
  await rig.acquire().catch(() => {})
  expect(rig.sent('authenticate')).toEqual([])
  expect(rig.openVerdict()).toMatchObject({ fact: { kind: 'notSignedIn' } })
})
