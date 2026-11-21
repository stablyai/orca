import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  GROK,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

function send(rig: AcpAdapterRig, clientMessageId: string) {
  return rig.adapter.dispatch({ sessionId: SESSION, clientMessageId, body: hello, fence: 1 })
}

function chunk(promptId: string, text: string) {
  return {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    _meta: { promptId }
  }
}

it('reads those last words when the agent ends its stdout before its exit is seen', async () => {
  const rig = await openAcpAdapterRig({
    script: (agent) =>
      agent.on('session/new', () => {
        const child = rig.child()
        child.stderr = 'grok: config.toml is invalid'
        // Simulate stdout EOF preceding observed process exit.
        child.agent.stdout.end()
      })
  })
  const acquiring = rig.acquire()
  await rig.frame('session/new')
  await rig.settle()
  expect(rig.ended).toEqual([])
  expect(rig.child().closes).toBe(0)
  rig.child().exit()
  await acquiring
  expect(rig.ended).toMatchObject([
    { failure: { detail: { text: 'grok: config.toml is invalid' } } }
  ])
})

describe('ACP structured session adapter: turns', () => {
  it('sends a prompt under an injected id and settles it on the agent first event', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    expect(await send(rig, 'send-1')).toEqual({ state: 'admitted' })
    const prompt = await rig.frame('session/prompt')
    expect(prompt.params).toMatchObject({
      prompt: [{ type: 'text', text: 'hello' }],
      _meta: { promptId: 'prompt:send-1', requestId: 'prompt:send-1' }
    })
    rig.child().agent.notify('session/update', chunk('prompt:send-1', 'Hi there'))
    await waitFor(() =>
      expect(rig.settled).toEqual([
        {
          sessionId: SESSION,
          clientMessageId: 'send-1',
          providerIdentity: { provider: 'orca', clientMessageId: 'send-1' }
        }
      ])
    )
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.at(-1)).toMatchObject({ state: 'completed', outcome: 'success' })
    })
  })

  it("switches OpenCode's agent to the message's Build/Plan mode before its prompt", async () => {
    const steps: string[] = []
    const mode = (currentValue: string) => ({
      id: 'mode',
      name: 'Session Mode',
      category: 'mode',
      type: 'select',
      currentValue,
      options: ['build', 'plan'].map((value) => ({ value, name: value }))
    })
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode')!,
      script: (agent) => {
        let current = 'build'
        agent.on('session/new', (frame) =>
          agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: [mode(current)] })
        )
        agent.on('session/set_config_option', (frame) => {
          const { configId, value } = z
            .object({ configId: z.string(), value: z.string() })
            .parse(frame.params)
          current = value
          steps.push(`${configId}=${value}`)
          agent.reply(frame, { configOptions: [mode(current)] })
        })
        agent.on('session/prompt', (frame) => {
          steps.push('prompt')
          agent.reply(frame, { stopReason: 'end_turn' })
        })
      }
    })
    await rig.acquire()
    for (const [clientMessageId, interactionMode] of [
      ['send-1', 'plan'],
      ['send-2', 'plan'],
      ['send-3', 'default']
    ] as const) {
      await rig.adapter.dispatch({
        sessionId: SESSION,
        clientMessageId,
        fence: 1,
        body: hello,
        executionOptions: { interactionMode }
      })
      await rig.settle()
    }
    expect(steps).toEqual(['mode=plan', 'prompt', 'prompt', 'mode=build', 'prompt'])
  })

  it('stops a running turn: open permissions answer cancelled, session/cancel goes out', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    const { agent } = rig.child()
    const permission = agent.request(7, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    })
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    await rig.settle()
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    expect(await permission).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(rig.sent('session/cancel')).toHaveLength(1)
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.at(-1)).toMatchObject({ state: 'interrupted' })
    })
  })
})

describe('ACP structured session adapter: approvals', () => {
  it('commits the journal answer before replying with the option the person chose', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    await rig.frame('session/prompt')
    const { agent } = rig.child()
    const reply = agent.request(3, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
      ]
    })
    const row = await waitFor(async () => {
      const found = (await rig.rig.rows()).find((item) => item.body.kind === 'approval')
      expect(found).toBeDefined()
      return found!
    })
    const order: string[] = []
    let answered = false
    void reply.then(() => {
      answered = true
      order.push('reply')
    })
    await rig.adapter.answerPrompt({
      sessionId: SESSION,
      itemId: row.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'reject-once' },
      fence: 1,
      commit: async () => {
        order.push('commit')
        expect(answered).toBe(false)
      }
    })
    expect(await reply).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } }
    })
    expect(order).toEqual(['commit', 'reply'])
    await expect(
      rig.adapter.answerPrompt({
        sessionId: SESSION,
        itemId: row.itemId,
        kind: 'approval',
        response: { kind: 'option', optionId: 'allow-once' },
        fence: 1,
        commit: async () => {}
      })
    ).rejects.toThrow(/no longer waiting/)
  })
  it('answers by the mode picked mid-reply: Full access approves, Ask asks again', async () => {
    const rig = await openAcpAdapterRig({ spec: acpLaunchSpecFor('opencode')! })
    await rig.acquire({ permissionMode: 'ask' })
    await send(rig, 'send-1')
    await rig.frame('session/prompt')
    const { agent } = rig.child()
    const ask = (id: number) =>
      agent.request(id, 'session/request_permission', {
        sessionId: PROVIDER_SESSION,
        toolCall: { toolCallId: `call-${id}`, title: 'Run command' },
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
      })
    const approvals = async () =>
      (await rig.rig.rows()).filter((row) => row.body.kind === 'approval').length

    await rig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'full-access' })
    expect(await ask(1)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
    expect(await approvals()).toBe(0)

    await rig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'ask' })
    void ask(2)
    await waitFor(async () => expect(await approvals()).toBe(1))
    expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)
  })
  it('sets the session mode at once for an agent that enforces its own modes', async () => {
    const mode = (currentValue: string) => ({
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue,
      options: ['default', 'yolo', 'auto'].map((value) => ({ value, name: value }))
    })
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('kimi')!,
      script: (agent) => {
        agent.on('session/new', (frame) =>
          agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: [mode('auto')] })
        )
        agent.on('session/set_config_option', (frame) => {
          const { value } = z.object({ value: z.string() }).parse(frame.params)
          agent.reply(frame, { configOptions: [mode(value)] })
        })
      }
    })
    await rig.acquire({ permissionMode: 'ask' })
    expect(rig.adapter.runningPermissionMode(SESSION)).toBe('ask')

    await rig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'full-access' })
    expect(rig.sent('session/set_config_option').at(-1)?.params).toMatchObject({
      configId: 'mode',
      value: 'auto'
    })
    expect(rig.adapter.runningPermissionMode(SESSION)).toBe('full-access')
    expect(rig.adapter.permissionModeRequiresAcquisition(SESSION, 'full-access')).toBe(false)
  })
  it('follows a mode the agent switches to itself, so Ask can switch it back', async () => {
    const mode = (currentValue: string) => ({
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue,
      options: ['plan', 'default', 'auto-edit', 'auto', 'yolo'].map((value) => ({
        value,
        name: value
      }))
    })
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('qwen-code')!,
      script: (agent) => {
        agent.on('session/new', (frame) =>
          agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: [mode('auto')] })
        )
        agent.on('session/set_config_option', (frame) => {
          const { value } = z.object({ value: z.string() }).parse(frame.params)
          agent.reply(frame, { configOptions: [mode(value)] })
        })
      }
    })
    await rig.acquire({ permissionMode: 'ask' })
    expect(rig.adapter.runningPermissionMode(SESSION)).toBe('ask')

    // Qwen 0.28 after the person picks "Allow All Edits" on an edit approval.
    rig.child().agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'auto-edit' }
    })
    await waitFor(() => expect(rig.adapter.runningPermissionMode(SESSION)).toBe('accept-edits'))

    await rig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'ask' })
    expect(rig.sent('session/set_config_option').at(-1)?.params).toMatchObject({
      configId: 'mode',
      value: 'default'
    })
  })
})

describe('ACP structured session adapter: requests a Stop cancels', () => {
  it('sends a permission answer whose save was under way when the Stop landed', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    const { agent } = rig.child()
    const permission = agent.request(6, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: { toolCallId: 'call-1', title: 'Write file' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
    })
    const row = await waitFor(async () => {
      const found = (await rig.rig.rows()).find((item) => item.body.kind === 'approval')
      expect(found).toBeDefined()
      return found!
    })
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    const answering = rig.adapter.answerPrompt({
      sessionId: SESSION,
      itemId: row.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'allow-once' },
      fence: 1,
      commit: () => rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 }).then(() => {})
    })
    // Stop must not preempt an answer already claimed for commit.
    await expect(answering).resolves.toBeUndefined()
    expect(await permission).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
    expect(rig.sent('session/cancel')).toHaveLength(1)
  })
})

describe('ACP structured session adapter: close and exit', () => {
  it('ends the session on an unexpected exit: held sends rejected, the running one unknown', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    await rig.frame('session/prompt')
    await send(rig, 'send-2')
    rig.child().stderr = 'grok: crashed'
    rig.child().exit()
    await waitFor(() =>
      expect(rig.ended).toMatchObject([
        {
          type: 'ended',
          cause: 'unexpected-exit',
          acquisitionGeneration: 'gen-acp',
          failure: { kind: 'providerExited' }
        }
      ])
    )
    expect(rig.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'send-2', state: 'rejected' }),
        expect.objectContaining({ clientMessageId: 'send-1', state: 'unknown' })
      ])
    )
    await expect(send(rig, 'send-3')).rejects.toThrow(/no live grok child/)
  })

  it('keeps a stopped turn interrupted when the later process settlement loses its CLI outcome', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await send(rig, 'send-1')
    const prompt = await rig.frame('session/prompt')
    rig
      .child()
      .agent.on('session/cancel', () =>
        rig.child().agent.reply(prompt, { stopReason: 'cancelled' })
      )
    await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.at(-1)).toMatchObject({ state: 'interrupted' })
    })
    rig.child().exit({ code: null, signal: null, processless: false, outcomeLost: true })
    await waitFor(() =>
      expect(rig.ended).toMatchObject([
        { cause: 'unexpected-exit', failure: { kind: 'hostFault' } }
      ])
    )
    const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    expect(turns.at(-1)).toMatchObject({ state: 'interrupted' })
  })
})

describe('Grok launch spec', () => {
  it('runs `grok agent stdio`, asking for always-approve only with full access', () => {
    expect(GROK.args({ fullAccess: false, pluginDirs: [] })).toEqual(['agent', 'stdio'])
    expect(GROK.args({ fullAccess: true, pluginDirs: [] })).toEqual([
      'agent',
      '--always-approve',
      'stdio'
    ])
    expect(GROK.args({ fullAccess: true, pluginDirs: ['/orca/visuals', '/repo/.agents'] })).toEqual(
      [
        'agent',
        '--always-approve',
        '--plugin-dir',
        '/orca/visuals',
        '--plugin-dir',
        '/repo/.agents',
        'stdio'
      ]
    )
  })
})
