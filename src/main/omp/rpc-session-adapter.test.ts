import { afterEach, expect, it, vi } from 'vitest'
import { state } from '../pi/rpc-session-adapter.test-fixture'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'
import {
  nativeChatNoticeBlock,
  nativeChatNoticeLook
} from '../../shared/native-chat/native-chat-notice'
import {
  closeOmpRpcAdapterFixtures,
  setupOmpRpcAdapter as setup
} from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

it('rejects Goal on older OMP without closing the chat or simulating a goal', async () => {
  const h = await setup()
  h.connection.requestOverride = (command) =>
    command === 'goal'
      ? Promise.reject(new JsonlRpcResponseError(command, 'Unknown command: goal'))
      : undefined
  await expect(
    h.adapter.changeThreadGoal({
      sessionId: 'omp-test',
      fence: 1,
      replacesGoal: false,
      change: { kind: 'set', objective: 'Keep native ownership' }
    })
  ).resolves.toMatchObject({
    ok: false,
    rejected: expect.stringContaining('does not expose native Goal')
  })
  expect(h.connection.closed).toBe(false)
  expect(
    (await h.rig.rows()).some((row) => row.body.kind === 'status' && row.body.threadGoal)
  ).toBe(false)
})

it('opens an OMP history identity and commits grouped Ask selections through existing cards', async () => {
  const h = await setup()
  expect(h.opened.link?.handle).toMatchObject({ agent: 'omp', transport: 'jsonl-rpc' })
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'ask-1',
    method: 'ask',
    questions: [
      {
        id: 'one',
        question: 'Choose two',
        multi: true,
        recommended: -1,
        options: [{ label: 'A' }, { label: 'B' }]
      },
      { id: 'two', question: 'Explain', options: [] }
    ]
  })
  const row = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  if (!row || row.body.kind !== 'question') {
    throw new Error('Ask not rendered')
  }
  expect(row.body.questions).toMatchObject([
    { id: 'one', multiSelect: true },
    { id: 'two', freeTextQuestionId: 'two' }
  ])
  const commit = vi.fn(async () => {})
  await h.adapter.answerPrompt({
    sessionId: 'omp-test',
    fence: 1,
    kind: 'question',
    itemId: row.itemId,
    commit,
    response: {
      kind: 'answers',
      answers: [
        { questionId: 'one', optionIds: ['option-0', 'option-1'] },
        { questionId: 'two', optionIds: [], other: 'my answer' }
      ]
    }
  })
  expect(commit).toHaveBeenCalledOnce()
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'ask-1',
    answers: [
      { id: 'one', selectedOptions: ['A', 'B'] },
      { id: 'two', selectedOptions: [], customInput: 'my answer' }
    ]
  })
})

it('keeps OMP todo calls on the shared task-list projection through settlement', async () => {
  const h = await setup()
  const phases = [
    {
      name: 'Discovery',
      tasks: [{ content: 'Inspect the protocol', status: 'in_progress' as const }]
    }
  ]
  h.connection.receive({
    type: 'tool_execution_start',
    toolCallId: 'todo-1',
    toolName: 'todo',
    args: { op: 'init', items: ['Inspect the protocol'], list: [] }
  })
  h.connection.receive({
    type: 'tool_execution_update',
    toolCallId: 'todo-1',
    toolName: 'todo',
    partialResult: { content: [{ type: 'text', text: 'working' }] }
  })
  expect((await h.rig.rows()).map((row) => row.body)).toEqual([
    expect.objectContaining({ kind: 'tool-call', name: 'update_plan', state: 'running' })
  ])
  h.connection.receive({
    type: 'tool_execution_end',
    toolCallId: 'todo-1',
    toolName: 'todo',
    result: { content: [], details: { op: 'init', phases } },
    isError: false
  })
  expect((await h.rig.rows()).map((row) => row.body)).toEqual([
    expect.objectContaining({ kind: 'tool-call', name: 'update_plan', state: 'completed' })
  ])
})

it('keeps an initially empty Goal silent while reporting a later Goal removal', async () => {
  const h = await setup()
  h.connection.receive({
    type: 'omp_state',
    state: { sessionFile: h.opened.link?.handle.nativeId, goal: null }
  })
  expect((await h.rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([])
  h.connection.receive({
    type: 'goal_updated',
    goal: {
      id: 'goal-1',
      objective: 'Ship it',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1
    }
  })
  h.connection.receive({ type: 'goal_updated', goal: null })
  expect(
    (await h.rig.rows()).flatMap((row) => (row.body.kind === 'status' ? [row.body.text] : []))
  ).toEqual(['Goal: Ship it (active)', 'Goal cleared'])
})

it('withdraws cancelled and expired dialogs and refuses unsupported blocking UI', async () => {
  const h = await setup()
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'cancelled',
    method: 'input',
    title: 'Value'
  })
  const row = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  if (!row) {
    throw new Error('Card missing')
  }
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'cancel-notice',
    method: 'cancel',
    targetId: 'cancelled'
  })
  await expect(
    h.adapter.answerPrompt({
      sessionId: 'omp-test',
      fence: 1,
      kind: 'question',
      itemId: row.itemId,
      commit: async () => {},
      response: {
        kind: 'answers',
        answers: [{ questionId: 'cancelled', optionIds: [], other: 'late' }]
      }
    })
  ).rejects.toThrow()
  h.connection.receive({ type: 'extension_ui_request', id: 'unknown', method: 'custom' })
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'unknown',
    cancelled: true
  })
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'secret',
    method: 'input',
    title: 'API key',
    secret: true
  })
  expect(h.connection.sent).toContainEqual({
    type: 'extension_ui_response',
    id: 'secret',
    cancelled: true
  })
  vi.useFakeTimers()
  try {
    h.connection.receive({
      type: 'extension_ui_request',
      id: 'timeout',
      method: 'confirm',
      title: 'Approve?',
      timeout: 10
    })
    await vi.advanceTimersByTimeAsync(11)
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'timeout',
      cancelled: true,
      timedOut: true
    })
  } finally {
    vi.useRealTimers()
  }
})

it('waits for OMP settlement and preserves failed prompt outcomes', async () => {
  const h = await setup()
  await h.adapter.dispatch({
    sessionId: 'omp-test',
    fence: 1,
    clientMessageId: 'prompt',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
  })
  h.connection.receive({ type: 'agent_start' })
  h.connection.receive({
    type: 'response',
    command: 'prompt',
    promptId: 'orca-prompt:prompt',
    success: true
  })
  h.connection.receive({ type: 'agent_end' })
  expect(
    (await h.rig.rows()).some((row) => row.body.kind === 'turn' && row.body.state === 'completed')
  ).toBe(false)
  h.connection.receive({
    type: 'prompt_result',
    id: 'orca-prompt:prompt',
    status: 'error',
    error: { message: 'quota exhausted' },
    sessionSettled: true
  })
  await vi.waitFor(async () =>
    expect(
      (await h.rig.rows()).some(
        (row) => row.body.kind === 'status' && row.body.text?.includes('quota exhausted')
      )
    ).toBe(true)
  )
  expect(
    (await h.rig.rows()).some((row) => row.body.kind === 'turn' && row.body.outcome === 'failure')
  ).toBe(true)
})

it('keeps commands and attachment prompts usable after a quota failure', async () => {
  const h = await setup()
  h.connection.requestOverride = (command) =>
    command === 'get_commands'
      ? Promise.resolve({
          commands: [
            { name: 'skill:review', source: 'skill' },
            { name: 'mcp', source: 'builtin' }
          ]
        })
      : undefined
  h.connection.receive({ type: 'available_commands_update' })
  await vi.waitFor(() =>
    expect(h.adapter.readCommands('omp-test')).toEqual([
      { name: 'skill:review', kind: 'skill' },
      { name: 'mcp', kind: 'command' }
    ])
  )
  const commands = h.adapter.readCommands('omp-test')
  for (const id of ['quota', 'attachment', 'follow-up']) {
    await h.adapter.dispatch({
      sessionId: 'omp-test',
      fence: 1,
      clientMessageId: id,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
    })
    h.connection.receive({ type: 'agent_start' })
    if (id === 'attachment') {
      const message = {
        role: 'fileMention',
        files: [{ path: 'invoice.xls', content: '(skipped auto-read: binary file)' }],
        timestamp: 1
      }
      h.connection.receive({ type: 'message_start', message })
      h.connection.receive({ type: 'message_end', message })
    }
    h.connection.receive({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: id === 'quota' ? [] : [{ type: 'text', text: `${id} received` }],
        stopReason: id === 'quota' ? 'error' : 'stop',
        ...(id === 'quota' ? { errorMessage: '403 insufficient_user_quota' } : {})
      }
    })
    h.connection.receive({
      type: 'response',
      command: 'prompt',
      promptId: `orca-prompt:${id}`,
      success: true
    })
    h.connection.receive({
      type: 'prompt_result',
      id: `orca-prompt:${id}`,
      status: id === 'quota' ? 'error' : 'completed',
      sessionSettled: true
    })
    await vi.waitFor(async () =>
      expect(
        (await h.rig.rows()).filter(
          (row) => row.body.kind === 'turn' && row.body.state === 'completed'
        )
      ).toHaveLength(id === 'quota' ? 1 : id === 'attachment' ? 2 : 3)
    )
    expect(h.adapter.readCommands('omp-test')).toEqual(commands)
  }
  expect(h.connection.closed).toBe(false)
  expect(h.logger.error).not.toHaveBeenCalled()
  expect(JSON.stringify(await h.rig.rows())).toContain('follow-up received')
})

it.each([5, 9])(
  'collects every answer to a %s-question Ask through bounded cards',
  async (count) => {
    const h = await setup()
    h.connection.receive({
      type: 'extension_ui_request',
      id: 'large-ask',
      method: 'ask',
      questions: Array.from({ length: count }, (_, i) => ({
        id: `q${i}`,
        question: `Question ${i}`,
        options: [{ label: `Choice ${i}` }]
      }))
    })
    const answered = new Set<string>()
    while (answered.size < Math.ceil(count / 4)) {
      const row = (await h.rig.rows()).find(
        (row) => row.body.kind === 'question' && !answered.has(row.itemId)
      )
      if (!row || row.body.kind !== 'question' || !row.body.questions) {
        throw new Error('Missing Ask page')
      }
      expect(row.body.questions.length).toBeLessThanOrEqual(4)
      expect(h.connection.sent.filter((frame) => frame.type === 'extension_ui_response')).toEqual(
        []
      )
      await h.adapter.answerPrompt({
        sessionId: 'omp-test',
        fence: 1,
        kind: 'question',
        itemId: row.itemId,
        commit: async () => {},
        response: {
          kind: 'answers',
          answers: row.body.questions.map((question) => ({
            questionId: question.id,
            optionIds: ['option-0']
          }))
        }
      })
      answered.add(row.itemId)
    }
    expect(h.connection.sent.filter((frame) => frame.type === 'extension_ui_response')).toEqual([
      {
        type: 'extension_ui_response',
        id: 'large-ask',
        answers: Array.from({ length: count }, (_, i) => ({
          id: `q${i}`,
          selectedOptions: [`Choice ${i}`]
        }))
      }
    ])
  }
)

it('cancels a grouped Ask from its second card without sending partial answers', async () => {
  const h = await setup()
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'cancel-group',
    method: 'ask',
    questions: Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`,
      question: `Question ${i}`,
      options: [{ label: 'Yes' }]
    }))
  })
  const first = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  if (!first || first.body.kind !== 'question' || !first.body.questions) {
    throw new Error('Missing first card')
  }
  await h.adapter.answerPrompt({
    sessionId: 'omp-test',
    fence: 1,
    kind: 'question',
    itemId: first.itemId,
    commit: async () => {},
    response: {
      kind: 'answers',
      answers: first.body.questions.map((question) => ({
        questionId: question.id,
        optionIds: ['option-0']
      }))
    }
  })
  const second = (await h.rig.rows()).find(
    (row) => row.body.kind === 'question' && row.itemId !== first.itemId
  )
  if (!second) {
    throw new Error('Missing second card')
  }
  await h.adapter.dismissPrompt({
    sessionId: 'omp-test',
    fence: 1,
    itemId: second.itemId,
    commit: async () => {},
    answer: true
  })
  expect(h.connection.sent.filter((frame) => frame.type === 'extension_ui_response')).toEqual([
    { type: 'extension_ui_response', id: 'cancel-group', cancelled: true }
  ])
})

it('keeps grouped answers retryable across rejected commits and failed final delivery', async () => {
  const h = await setup()
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'retry-group',
    method: 'ask',
    questions: Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`,
      question: `Question ${i}`,
      options: [{ label: 'Yes' }]
    }))
  })
  const first = (await h.rig.rows()).find((row) => row.body.kind === 'question')
  if (!first || first.body.kind !== 'question' || !first.body.questions) {
    throw new Error('Missing first card')
  }
  const firstAnswer = {
    sessionId: 'omp-test',
    fence: 1,
    kind: 'question' as const,
    itemId: first.itemId,
    commit: async () => {},
    response: {
      kind: 'answers' as const,
      answers: first.body.questions.map((question) => ({
        questionId: question.id,
        optionIds: ['option-0']
      }))
    }
  }
  await expect(
    h.adapter.answerPrompt({
      ...firstAnswer,
      commit: async () => {
        throw new Error('Commit failed')
      }
    })
  ).rejects.toThrow('Commit failed')
  expect((await h.rig.rows()).filter((row) => row.body.kind === 'question')).toHaveLength(1)
  expect(h.connection.sent).toEqual([])
  await h.adapter.answerPrompt(firstAnswer)
  const second = (await h.rig.rows()).find(
    (row) => row.body.kind === 'question' && row.itemId !== first.itemId
  )
  if (!second) {
    throw new Error('Missing second card')
  }
  const finalAnswer = {
    ...firstAnswer,
    itemId: second.itemId,
    response: {
      kind: 'answers' as const,
      answers: [{ questionId: 'q4', optionIds: ['option-0'] }]
    }
  }
  vi.spyOn(h.connection, 'send').mockRejectedValueOnce(new Error('Write failed'))
  await expect(h.adapter.answerPrompt(finalAnswer)).rejects.toThrow('Write failed')
  await h.adapter.answerPrompt(finalAnswer)
  expect(h.connection.sent).toEqual([
    {
      type: 'extension_ui_response',
      id: 'retry-group',
      answers: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, selectedOptions: ['Yes'] }))
    }
  ])
  expect(h.connection.closed).toBe(false)
})

it.each(['native', 'host'] as const)(
  'withdraws the active grouped card on %s cancellation and releases its native identity',
  async (source) => {
    const h = await setup()
    const request = {
      type: 'extension_ui_request',
      id: 'withdraw-group',
      method: 'ask',
      questions: Array.from({ length: 5 }, (_, i) => ({
        id: `q${i}`,
        question: `Question ${i}`,
        options: [{ label: 'Yes' }]
      }))
    }
    h.connection.receive(request)
    const row = (await h.rig.rows()).find((row) => row.body.kind === 'question')
    if (!row) {
      throw new Error('Missing card')
    }
    if (source === 'native') {
      h.connection.receive({
        type: 'extension_ui_request',
        id: 'cancel-notice',
        method: 'cancel',
        targetId: request.id
      })
    } else {
      await h.adapter.dismissPrompt({
        sessionId: 'omp-test',
        fence: 1,
        itemId: row.itemId,
        commit: async () => {},
        answer: false
      })
    }
    await expect(
      h.adapter.answerPrompt({
        sessionId: 'omp-test',
        fence: 1,
        kind: 'question',
        itemId: row.itemId,
        commit: async () => {},
        response: { kind: 'answers', answers: [] }
      })
    ).rejects.toThrow()
    expect(h.connection.sent).toEqual([])
    h.connection.receive(request)
    expect((await h.rig.rows()).filter((row) => row.body.kind === 'question')).toHaveLength(2)
    await h.adapter.closeAll()
    expect(h.connection.sent).toEqual([
      { type: 'extension_ui_response', id: request.id, cancelled: true }
    ])
  }
)

it.each(['attempt', 'registration'] as const)(
  'reports native subagents through %s reporting without orchestration workers',
  async (reporting) => {
    const h = await setup(reporting)
    h.connection.receive({
      type: 'subagent_lifecycle',
      payload: { id: 'native-child', agent: 'researcher', status: 'started', index: 0 }
    })
    h.connection.receive({
      type: 'subagent_lifecycle',
      payload: { id: 'native-child', agent: 'researcher', status: 'completed', index: 0 }
    })
    h.connection.receive({
      type: 'subagent_lifecycle',
      payload: { id: 'native-child', agent: 'researcher', status: 'completed', index: 0 }
    })
    await h.rig.rows()
    expect(h.childWork.mock.calls.flat(2)).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        outcome: 'succeeded',
        handle: { idKind: 'task_id', id: 'native-child' }
      })
    )
    expect(h.childWork.mock.calls.flat(2).filter((item) => item.type === 'ended')).toHaveLength(1)
    expect(await h.adapter.cancelTurn({ sessionId: 'omp-test', fence: 1 })).toEqual({
      cancelled: true
    })
    expect(h.connection.requests).toContain('abort')
  }
)

it.each([
  ['info', 'notice'],
  ['warning', 'warning'],
  ['error', 'error']
] as const)('renders OMP %s notifications using existing Chat notices', async (level, tone) => {
  const h = await setup()
  const message = 'xd://: mounted mcp__orca_component_fixtures_list_fixtures'
  h.connection.receive({ type: 'notice', level, message, source: 'xdev' })
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'extension-notice',
    method: 'notify',
    message: 'Extension ready',
    notifyType: level
  })
  const messages = projectStructuredItemsToNativeChat(await h.rig.rows())
  expect(messages).toHaveLength(2)
  for (const [index, text] of [message, 'Extension ready'].entries()) {
    const row = messages[index]!
    expect(row.role).toBe('system')
    const block = nativeChatNoticeBlock(row.blocks)
    expect(block?.text).toBe(text)
    expect(block && nativeChatNoticeLook(block)).toEqual({ kind: 'line', tone })
  }
})

it('shows native command results and extension failures and rejects external session changes', async () => {
  const h = await setup()
  h.connection.receive({ type: 'command_output', text: 'Current model: model-1' })
  const commandOutputs = ['MCP servers:\n  fixtures: connected', 'Tools:\n  read\n  write']
  for (const text of commandOutputs) {
    h.connection.receive({ type: 'command_output', text })
  }
  h.connection.receive({
    type: 'extension_error',
    extensionPath: '/project/check.ts',
    event: 'tool_call',
    error: 'Extension refused this tool'
  })
  const rows = await h.rig.rows()
  expect(
    rows.some((row) => row.body.kind === 'status' && row.body.text === 'Current model: model-1')
  ).toBe(true)
  const messages = projectStructuredItemsToNativeChat(rows)
  for (const text of commandOutputs) {
    const message = messages.find((row) =>
      row.blocks.some((block) => block.type === 'text' && block.text === text)
    )
    expect(message?.role).toBe('system')
    const block = message && nativeChatNoticeBlock(message.blocks)
    expect(block && nativeChatNoticeLook(block)).toEqual({ kind: 'line', tone: 'notice' })
  }
  expect(
    rows.some(
      (row) =>
        row.body.kind === 'status' &&
        row.body.tone === 'error' &&
        row.body.text?.includes('Extension refused this tool')
    )
  ).toBe(true)
  h.connection.receive({
    type: 'omp_state',
    state: { sessionFile: '/different/session.jsonl', goal: null }
  })
  await vi.waitFor(() => expect(h.connection.closed).toBe(true))
})

it('refuses timed Ask immediately because OMP owns an earlier auto-answer deadline', async () => {
  const h = await setup()
  vi.useFakeTimers()
  try {
    h.connection.receive({
      type: 'extension_ui_request',
      id: 'expired-ask',
      method: 'ask',
      timeout: 10,
      questions: [
        {
          id: 'q',
          question: 'Approve?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          recommended: 0
        }
      ]
    })
    await vi.advanceTimersByTimeAsync(11)
    expect(h.connection.sent).toContainEqual({
      type: 'extension_ui_response',
      id: 'expired-ask',
      cancelled: true
    })
  } finally {
    vi.useRealTimers()
  }
})

it('keeps an active chat when optional model discovery fails after a config change', async () => {
  const h = await setup()
  h.connection.requestOverride = (command) =>
    command === 'get_available_models'
      ? Promise.reject(new Error('Temporary catalog failure'))
      : undefined
  h.connection.receive({ type: 'config_update', thinkingLevel: 'low' })
  await vi.waitFor(async () =>
    expect(
      (await h.rig.rows()).some(
        (row) => row.body.kind === 'status' && row.body.text?.includes('could not be refreshed')
      )
    ).toBe(true)
  )
  expect(h.connection.closed).toBe(false)
})

it('reads held options without contacting OMP when state requests would fail', async () => {
  const h = await setup()
  await vi.waitFor(() => expect(h.adapter.readCommands('omp-test')).toBeDefined())
  h.connection.requestOverride = (command) =>
    command === 'get_state' ? Promise.reject(new Error('State unavailable')) : undefined
  const request = vi.spyOn(h.connection, 'request')
  await expect(h.adapter.readOptions({ sessionId: 'omp-test', fence: 1 })).resolves.toMatchObject({
    current: { model: 'anthropic/model-1' }
  })
  expect(request).not.toHaveBeenCalled()
  expect(h.connection.closed).toBe(false)
})

it('sets native Fast mode and reports its actual preference and effective state', async () => {
  const h = await setup()
  await vi.waitFor(() => expect(h.adapter.readCommands('omp-test')).toBeDefined())
  let enabled = false
  h.connection.requestOverride = (command) =>
    command === 'get_state'
      ? Promise.resolve({
          ...state,
          sessionFile: h.opened.link?.handle.nativeId,
          model: { provider: 'anthropic', id: 'model-1', api: 'anthropic-messages' },
          fastModeEnabled: enabled,
          fastModeActive: enabled
        })
      : command === 'set_fast_mode'
        ? Promise.resolve({ enabled: true, active: false })
        : undefined
  h.connection.receive({ type: 'config_update' })
  await vi.waitFor(async () =>
    expect(
      (await h.adapter.readOptions({ sessionId: 'omp-test', fence: 1 })).fastModeSupport
    ).toEqual({ supported: true })
  )
  const request = vi.spyOn(h.connection, 'request')
  const before = await h.adapter.readOptions({ sessionId: 'omp-test', fence: 1 })
  expect(before.fastModeSupport).toEqual({ supported: true })
  expect(before.current.fastMode).toBe(false)
  expect(request).not.toHaveBeenCalled()
  await h.adapter.setOption({ sessionId: 'omp-test', fence: 1, key: 'fastMode', value: 'true' })
  expect(request).toHaveBeenCalledWith('set_fast_mode', { enabled: true })
  expect((await h.adapter.readOptions({ sessionId: 'omp-test', fence: 1 })).current).toMatchObject({
    fastMode: true,
    fastModeState: 'off'
  })
  expect(request.mock.calls.map(([command]) => command)).toEqual(['set_fast_mode'])
  enabled = true
  h.connection.receive({ type: 'config_update' })
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('get_state'))
  await vi.waitFor(async () =>
    expect(
      (await h.adapter.readOptions({ sessionId: 'omp-test', fence: 1 })).current
    ).toMatchObject({
      fastMode: true,
      fastModeState: 'on'
    })
  )
})

it.each([
  ['model', 'openai/another-model'],
  ['effort', 'low']
])('keeps a successful %s write when the following catalog refresh fails', async (key, value) => {
  const h = await setup()
  const failure = new Error('Temporary catalog failure')
  h.connection.requestOverride = (command) =>
    command === 'get_available_models'
      ? Promise.reject(failure)
      : command === 'set_thinking_level'
        ? Promise.resolve({})
        : undefined
  await expect(
    h.adapter.setOption({ sessionId: 'omp-test', fence: 1, key, value })
  ).resolves.toMatchObject({ [key]: value })
  expect((await h.adapter.readOptions({ sessionId: 'omp-test', fence: 1 })).current).toMatchObject({
    [key]: value
  })
  expect(h.connection.closed).toBe(false)
  expect(h.logger.warn).toHaveBeenCalledWith(
    'OMP options could not be refreshed after a write',
    expect.objectContaining({ sessionId: 'omp-test', error: failure })
  )
})

it('still rejects a failed option write without starting a follow-up refresh', async () => {
  const h = await setup()
  const failure = new Error('Model unavailable')
  h.connection.requestOverride = (command) =>
    command === 'set_model' ? Promise.reject(failure) : undefined
  const before = h.connection.requests.length
  await expect(
    h.adapter.setOption({ sessionId: 'omp-test', fence: 1, key: 'model', value: 'openai/missing' })
  ).rejects.toBe(failure)
  expect(h.connection.requests.slice(before)).toContain('set_model')
  expect(h.connection.requests.slice(before)).not.toContain('get_available_models')
})
