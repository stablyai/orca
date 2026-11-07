import { afterEach, expect, it, vi } from 'vitest'
import 'zod'
import capture from '../../shared/__fixtures__/omp-native-commands.json'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session/agent-session-wire'
import { openHostRig, send } from './acp-structured-host.test-support'
import './acp-launch-specs'
import { PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { commandDiscoveryRig, OMP } from './acp-command-discovery.test-fixture'
import { createTestParams } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-create-test-fixture'
import { buildNativeChatPickerItems } from '../../shared/native-chat/input/native-chat-picker-items'
import {
  sessionReportedSkills,
  sessionSlashCommandSuggestions
} from '../../shared/native-chat/input/native-chat-slash-commands'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from '../runtime/rpc/methods/structured-sessions/catalog/structured-agent-session-options-read'
import { handleStructuredAgentSessionCreate } from '../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create-handler'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../shared/agent-session/agent-session-create-capabilities'
import { deferred, tick } from './acp-scripted-agent.test-support'
import './acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

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
