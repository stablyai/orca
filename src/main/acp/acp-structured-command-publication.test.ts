import { afterEach, expect, it, vi } from 'vitest'
import capture from '../../shared/__fixtures__/omp-native-commands.json'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { openHostRig, send } from './acp-structured-host.test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { FakeAcpChild, PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { commandDiscoveryRig, OMP } from './acp-command-discovery.test-fixture'
import { createTestParams } from '../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { buildNativeChatPickerItems } from '../../shared/native-chat/input/native-chat-picker-items'
import {
  sessionReportedSkills,
  sessionSlashCommandSuggestions
} from '../../shared/native-chat/input/native-chat-slash-commands'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from '../runtime/rpc/methods/structured-agent-session-options-read'
import { handleStructuredAgentSessionCreate } from '../runtime/rpc/methods/structured-agent-session-create-handler'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../shared/agent-session-create-capabilities'
import { deferred, tick } from './acp-scripted-agent.test-support'

afterEach(closeProviderTimelineRigs)

it.each([
  ['omp', 10],
  ['omp', 100],
  ['grok', 10]
] as const)(
  'publishes %s command-only reports without visiting %i unrelated sessions',
  async (agent, count) => {
    const spec = acpLaunchSpecFor(agent)!
    const subscribe = vi.spyOn(FakeAcpChild.prototype, 'subscribe')
    const { rig, host, ready } = await openHostRig({
      spec,
      script: (agent) => {
        agent.on('session/new', (frame) => {
          agent.notify('session/update', { sessionId: PROVIDER_SESSION, update: capture.disabled })
          agent.reply(frame, { sessionId: PROVIDER_SESSION })
        })
      }
    })
    expect(
      await host.attach(
        CALLER,
        hostTestAttachParams(null, {
          provider: agent,
          agent,
          providerHandle: undefined,
          accountHome: {
            variable: agent === 'omp' ? 'PI_CODING_AGENT_DIR' : 'GROK_HOME',
            path: '/fake/account'
          }
        })
      )
    ).toMatchObject({ ok: true })
    await ready()
    const lateReport = subscribe.mock.calls[0]![0]
    subscribe.mockRestore()
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = await host.subscribe({
      id: 'desktop',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    expect(events[0]).toMatchObject({ commands: [{ name: 'compact', kind: 'command' }] })
    const { subscribers, sessions } = host.collaboratorsForTests()
    const journal = sessions.get(SESSION)!.journal
    const unrelated = vi.fn()
    const stops = Array.from({ length: count }, (_, index) =>
      subscribers.open({
        id: `desktop-${index}`,
        sessionId: `unrelated-${index}`,
        journal,
        fence: 1,
        emit: unrelated
      })
    )
    const reads = vi.spyOn(rig.adapter, 'readCommands')
    try {
      for (const report of [
        capture.enabled,
        capture.disabled,
        { sessionUpdate: 'available_commands_update', availableCommands: [] }
      ]) {
        events.length = 0
        unrelated.mockClear()
        reads.mockClear()
        rig.child().agent.notify('session/update', { sessionId: PROVIDER_SESSION, update: report })
        await rig.settle()
        await host.flushStreamedEvents(SESSION)
        await waitFor(() => expect(events).toHaveLength(1))
        const frame = events[0]!
        if (frame.type === 'end') {
          throw new Error('Expected command publication')
        }
        expect(frame.commands?.map(({ name, kind }) => [name, kind])).toEqual(
          report.availableCommands.map(({ name }) => [name, 'command'])
        )
        expect(await host.readCommands(SESSION)).toEqual({ commands: frame.commands })
        expect(unrelated).not.toHaveBeenCalled()
        expect(new Set(reads.mock.calls.map(([id]) => id))).toEqual(new Set([SESSION]))
        expect(reads.mock.calls.length).toBeLessThanOrEqual(8)
      }
      await host.close(SESSION, 'user-close')
      events.length = 0
      reads.mockClear()
      lateReport({
        kind: 'known',
        notification: {
          sessionId: PROVIDER_SESSION,
          update: { sessionUpdate: 'available_commands_update', availableCommands: [] }
        }
      })
      await rig.settle()
      expect(events).toEqual([])
      expect(reads).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
      stops.forEach((stop) => stop())
      unsubscribe()
      await host.close(SESSION, 'user-close')
    }
  }
)

it('answers modern empty-chat first-open through RPC and desktop subscription before acquire, then sends exact native tokens', async () => {
  const close = deferred<void>()
  const discovery = await commandDiscoveryRig((child) => {
    const prove = child.proveClose
    child.proveClose = async () => {
      await close.promise
      return prove()
    }
  })
  const { host, rig } = await openHostRig({
    spec: OMP,
    deps: { atRestCommands: discovery.catalog },
    script: (agent) => {
      agent.on('session/new', (frame) => {
        agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          update: { sessionUpdate: 'available_commands_update', availableCommands: [] }
        })
        agent.reply(frame, { sessionId: PROVIDER_SESSION })
      })
      agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    }
  })
  const acquire = vi.spyOn(rig.adapter, 'acquire')
  const events: AgentSessionSubscribeEvent[] = []
  let unsubscribe = () => {}
  setStructuredAgentSessionHost(host)
  try {
    const params = createTestParams(undefined, {
      provider: 'omp',
      agent: 'omp',
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/accounts/omp' }
    })
    const runtime = new OrcaRuntimeService()
    const resolveIntent = vi
      .spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent')
      .mockResolvedValue(params)
    const publishTab = vi
      .spyOn(runtime, 'publishStructuredAgentSessionTab')
      .mockResolvedValue(undefined)
    expect(
      await handleStructuredAgentSessionCreate(
        { worktree: 'id:workspace-1', agent: 'omp', envelope: params.envelope },
        {
          runtime,
          clientCapabilities: [AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY]
        }
      )
    ).toMatchObject({ ok: true })
    resolveIntent.mockRestore()
    publishTab.mockRestore()
    unsubscribe = await host.subscribe({
      id: 'desktop-first-open',
      sessionId: SESSION,
      emit: (frame) => events.push(frame)
    })
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS
    })
    const replies: unknown[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'phone-one-shot',
        authToken: 'fixture',
        method: 'agentSession.commands',
        params: { sessionId: SESSION }
      },
      (raw) => replies.push(JSON.parse(raw))
    )
    const { commands } = await host.readCommands(SESSION)
    expect(replies).toEqual([expect.objectContaining({ ok: true, result: { commands } })])
    expect(commands).toEqual(
      capture.enabled.availableCommands.map(({ name, description, input }) => ({
        name,
        description,
        argumentHint: input.hint,
        kind: 'command'
      }))
    )
    await waitFor(() =>
      expect(
        events.some(
          (frame) =>
            frame.type !== 'end' && frame.commands?.some((row) => row.name === 'skill:plan')
        )
      ).toBe(true)
    )
    expect(acquire).not.toHaveBeenCalled()
    expect(discovery.children[0]!.exited).toBe(false)
    const rows = buildNativeChatPickerItems(
      sessionSlashCommandSuggestions('omp', commands!),
      [],
      'skill:pl',
      '/',
      sessionReportedSkills(commands!, 'omp')
    )
    const selected = rows.find((row) => row.kind === 'skill' && row.token === '/skill:plan')!
    expect(selected).toBeDefined()
    // Older desktops consume the same command-kind row; new desktops group it as a skill.
    expect(
      sessionSlashCommandSuggestions('grok', commands!).some((row) => row.name === 'skill:plan')
    ).toBe(true)
    await send(host, `${selected.token} focus on tests`)
    const first = await rig.frame('session/prompt')
    expect(first.params).toMatchObject({
      prompt: [{ type: 'text', text: '/skill:plan focus on tests' }]
    })
    await rig.settle()
    expect(await host.readCommands(SESSION)).toEqual({ commands: [] })
    await send(host, '/skill:team/plan manual arguments')
    expect((await rig.frame('session/prompt', 1)).params).toMatchObject({
      prompt: [{ type: 'text', text: '/skill:team/plan manual arguments' }]
    })
    expect(discovery.children).toHaveLength(1)
  } finally {
    acquire.mockRestore()
    unsubscribe()
    setStructuredAgentSessionHost(null)
    await host.close(SESSION, 'user-close')
    let drained = false
    const shutdown = rig.adapter.closeAll().then(() => {
      drained = true
    })
    await tick()
    close.resolve()
    expect(drained).toBe(false)
    await shutdown
    await discovery.dispose()
  }
})
