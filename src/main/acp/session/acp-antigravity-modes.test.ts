import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../antigravity/antigravity-acp-launch-spec'
import { antigravityHostAccountHome } from '../../antigravity/antigravity-host-acp'
import { agentChatPermissionModes } from '../../../shared/agent-launch/permissions/agent-chat-permission-support'
import { agentSessionInteractionCommand } from '../../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import {
  closeProviderTimelineRigs,
  SESSION as ADAPTER_SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_SESSION as HOST_SESSION,
  hostTestAttachParams
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { AcpScriptedAgent } from '../process/testing/acp-scripted-agent.test-support'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor
} from './testing/acp-structured-adapter.test-support'
import { framesOf, openHostRig, send } from './testing/acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const HOST_SPEC = ANTIGRAVITY_LAUNCH_SPEC.hostBackend!.spec

function agyModeConfigOptions(modes: readonly string[], currentMode = 'default') {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gemini-4-carbon',
      options: [
        { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' }
      ]
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: currentMode,
      options: modes.map((value) => ({ value, name: value }))
    }
  ]
}

function scriptAgyModes(modes: readonly string[]) {
  return (agent: AcpScriptedAgent) => {
    let configOptions = agyModeConfigOptions(modes)
    agent.confirmConfigOptions(configOptions)
    agent.on('session/new', (frame) =>
      agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
    )
    agent.on('session/set_config_option', (frame) => {
      const parsed = z.object({ configId: z.string(), value: z.string() }).parse(frame.params)
      configOptions = configOptions.map((option) =>
        option.id === parsed.configId ? { ...option, currentValue: parsed.value } : option
      )
      agent.reply(frame, { configOptions })
    })
  }
}

describe('Antigravity auto and native plan execution modes', () => {
  it('exposes auto permission mode and validates whether the session mode menu offers it', async () => {
    expect(agentChatPermissionModes('antigravity')?.modes).toEqual([
      'ask',
      'accept-edits',
      'auto',
      'full-access'
    ])
    expect(agentSessionInteractionCommand('antigravity', '/plan')).toBe('plan')

    // Host `agy >= 1.5.4` (personal / ADC) offers `auto` in `configOptions[mode]`.
    const capable = await openAcpAdapterRig({
      spec: HOST_SPEC,
      script: scriptAgyModes(['default', 'accept-edits', 'auto', 'plan'])
    })
    await capable.acquire({ permissionMode: 'auto' })
    expect(capable.started().reportedOptions).toMatchObject({
      reportedPermissionMode: 'auto',
      interactionMode: 'default'
    })
    expect(capable.sent('session/set_config_option')).toMatchObject([
      { params: { configId: 'mode', value: 'auto' } }
    ])

    // Host `agy < 1.5.4` or Gemini Enterprise omits `auto` from `configOptions[mode]`.
    const withoutAuto = await openAcpAdapterRig({
      spec: HOST_SPEC,
      script: scriptAgyModes(['default', 'accept-edits', 'plan'])
    })
    await withoutAuto.acquire({ permissionMode: 'auto' })
    expect(String(withoutAuto.openFailure())).toMatch(
      /Antigravity on this host cannot run in the auto permission mode/
    )

    // Managed `1.4.1` offers only `default`, `auto_edit`, `yolo` (neither `auto` nor `plan`).
    const managed = await openAcpAdapterRig({
      spec: ANTIGRAVITY_LAUNCH_SPEC,
      script: scriptAgyModes(['default', 'auto_edit', 'yolo'])
    })
    await managed.acquire({ permissionMode: 'ask' })
    expect(managed.started().reportedOptions.interactionMode).toBeUndefined()
    await expect(
      managed.adapter.setOption({
        sessionId: ADAPTER_SESSION,
        fence: 1,
        key: 'interactionMode',
        value: 'plan'
      })
    ).rejects.toThrow(/offers no session option named interactionMode/)
  })

  it('withholds interactionMode at rest when pinned to the managed 1.4.1 runtime', async () => {
    const managedRig = await openHostRig({
      spec: ANTIGRAVITY_LAUNCH_SPEC,
      script: scriptAgyModes(['default', 'auto_edit', 'yolo'])
    })
    expect(
      await managedRig.host.attach(
        CALLER,
        hostTestAttachParams(null, {
          provider: 'antigravity',
          agent: 'antigravity',
          accountHome: { variable: 'GEMINI_HOME', path: '/state/antigravity-chat' },
          providerHandle: undefined
        })
      )
    ).toMatchObject({ ok: true })
    const managedRest = await managedRig.host.readOptions(HOST_SESSION)
    expect(managedRest.current.interactionMode).toBeUndefined()
    expect(
      await managedRig.host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', { key: 'interactionMode', value: 'plan' }),
        key: 'interactionMode',
        value: 'plan'
      })
    ).toMatchObject({ ok: false })
  })

  it('enables idle plan toggles and plan-approval mode transitions on host agy while preserving auto build mode', async () => {
    const { rig, host, store } = await openHostRig({
      spec: ANTIGRAVITY_LAUNCH_SPEC,
      deps: {
        resolveLaunch: async () => ({
          spec: HOST_SPEC,
          command: '/usr/local/bin/agy',
          prefixArgs: [],
          args: ['acp'],
          cwd: '/workspace',
          env: {},
          envToDelete: [],
          fullAccess: false,
          resume: null
        })
      },
      script: scriptAgyModes(['default', 'accept-edits', 'auto', 'plan'])
    })
    expect(
      await host.attach(
        CALLER,
        hostTestAttachParams(null, {
          provider: 'antigravity',
          agent: 'antigravity',
          options: { permissionMode: 'auto' },
          accountHome: antigravityHostAccountHome('/Users/neo'),
          providerHandle: undefined
        })
      )
    ).toMatchObject({ ok: true })

    const hostRest = await host.readOptions(HOST_SESSION)
    expect(hostRest.current.interactionMode).toBe('default')

    // Start the session in `auto` build permission mode, then switch to `plan` and back while idle.
    await send(host, 'Outline the changes')
    const firstPrompt = await rig.frame('session/prompt', 0)
    const { agent } = rig.child()
    agent.reply(firstPrompt, { stopReason: 'end_turn' })
    await waitFor(async () => {
      const live = await host.readOptions(HOST_SESSION)
      expect(live.current).toMatchObject({
        reportedPermissionMode: 'auto',
        interactionMode: 'default'
      })
    })

    expect(
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', { key: 'interactionMode', value: 'plan' }),
        key: 'interactionMode',
        value: 'plan'
      })
    ).toMatchObject({ ok: true })
    await waitFor(() =>
      expect(framesOf(rig.child(), 'session/set_config_option').map((f) => f.params)).toEqual([
        expect.objectContaining({ configId: 'mode', value: 'auto' }),
        expect.objectContaining({ configId: 'mode', value: 'plan' })
      ])
    )

    // Exiting plan mode while idle restores `auto` rather than downgrading to `default`.
    expect(
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', { key: 'interactionMode', value: 'default' }),
        key: 'interactionMode',
        value: 'default'
      })
    ).toMatchObject({ ok: true })
    await waitFor(() =>
      expect(framesOf(rig.child(), 'session/set_config_option').map((f) => f.params)).toEqual([
        expect.objectContaining({ configId: 'mode', value: 'auto' }),
        expect.objectContaining({ configId: 'mode', value: 'plan' }),
        expect.objectContaining({ configId: 'mode', value: 'auto' })
      ])
    )

    // Enter plan mode again and verify plan approval `allow_always` returns `interactionMode` to `default`
    // and restores `auto` on the next build turn.
    await host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', { key: 'interactionMode', value: 'plan' }),
      key: 'interactionMode',
      value: 'plan'
    })
    await waitFor(() => expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(4))
    await send(host, 'Draft implementation plan')
    const secondPrompt = await rig.frame('session/prompt', 1)
    const approval = agent.request(11, 'session/request_permission', {
      sessionId: PROVIDER_SESSION,
      toolCall: {
        toolCallId: 'call_plan_doc',
        name: 'write_file',
        title: 'Write implementation_plan.md',
        rawInput: {
          Path: '/workspace/implementation_plan.md',
          Content: '# Plan\n- Ship feature',
          ArtifactMetadata: { RequestFeedback: true, Summary: 'Plan', UserFacing: true }
        }
      },
      options: [
        { optionId: 'allow_always', name: 'Allow Always', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
      ]
    })
    const card = await waitFor(async () => {
      const page = await host.history({ sessionId: HOST_SESSION, direction: 'tail' })
      const item = page.ok ? page.page.items.find((entry) => entry.body.kind === 'approval') : null
      expect(item).toBeTruthy()
      return item!
    })
    const answerFields = {
      itemId: card.itemId,
      expectedRevision: card.revision,
      optionId: 'allow_always'
    }
    expect(
      await host.respondToPrompt(CALLER, {
        envelope: envelope('agentSession.respondTo:approval', answerFields),
        kind: 'approval',
        ...answerFields
      })
    ).toMatchObject({ ok: true })
    await approval
    expect(store.getRecord(HOST_SESSION)?.options?.interactionMode).toBe('default')
    agent.reply(secondPrompt, { stopReason: 'end_turn' })

    await send(host, 'Proceed with implementation')
    const thirdPrompt = await rig.frame('session/prompt', 2)
    expect(framesOf(rig.child(), 'session/set_config_option').at(-1)?.params).toMatchObject({
      configId: 'mode',
      value: 'auto'
    })
    agent.reply(thirdPrompt, { stopReason: 'end_turn' })
  })
})
