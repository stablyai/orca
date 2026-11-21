import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
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

const HERMES = acpLaunchSpecFor('hermes')!
afterEach(closeProviderTimelineRigs)

// Captured from Hermes 0.23.1: a command its approval policy flags, under the default manual mode.
const COMMAND_APPROVAL = {
  sessionId: PROVIDER_SESSION,
  toolCall: {
    toolCallId: 'perm-check-1',
    title: 'recursive delete: rm -rf /tmp/proj/zz',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'rm -rf /tmp/proj/zz', description: 'recursive delete' },
    content: [
      {
        type: 'content',
        content: { type: 'text', text: 'recursive delete\n$ rm -rf /tmp/proj/zz' }
      }
    ]
  },
  options: [
    { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once' },
    { kind: 'allow_always', name: 'Allow for session', optionId: 'allow_session' },
    { kind: 'allow_always', name: 'Allow always', optionId: 'allow_always' },
    { kind: 'reject_once', name: 'Deny', optionId: 'deny' },
    { kind: 'reject_always', name: 'Deny always', optionId: 'deny_always' }
  ]
}

const modeOption = (currentValue: string) => ({
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue,
  options: ['ask', 'workspace_session', 'session'].map((value) => ({ value, name: value }))
})

const approvalPolicy = (currentValue: string) => ({
  id: 'edit_approval_policy',
  name: 'Edit approval',
  type: 'select',
  currentValue,
  options: ['ask', 'workspace_session', 'session'].map((value) => ({ value, name: value }))
})

const interactionMode = {
  id: 'interaction_mode',
  name: 'Interaction',
  category: 'mode',
  type: 'select',
  currentValue: 'build',
  options: ['build', 'plan'].map((value) => ({ value, name: value }))
}

const listedModels = {
  currentModelId: 'gpt-5.4',
  availableModels: [{ modelId: 'gpt-5.4', name: 'gpt-5.4' }]
}

const modelSelect = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'openai:gpt-5',
  options: [{ value: 'openai:gpt-5', name: 'GPT-5' }]
}

const effortSelect = {
  id: 'reasoning_effort',
  name: 'Reasoning Effort',
  category: 'thought_level',
  type: 'select',
  currentValue: 'high',
  options: [{ value: 'high', name: 'High' }]
}

async function shownApproval(
  rig: Awaited<ReturnType<typeof openAcpAdapterRig>>,
  expectedCount = 1
) {
  let approvals: Awaited<ReturnType<typeof rig.rig.rows>> = []
  await waitFor(async () => {
    approvals = (await rig.rig.rows()).filter((row) => row.body.kind === 'approval')
    expect(approvals).toHaveLength(expectedCount)
  })
  return approvals
}

it('lists the models Hermes 0.23.0 returns on session/new when the mode write echoes no menu', async () => {
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          models: {
            currentModelId: 'openrouter:anthropic/claude-sonnet-4.5',
            availableModels: [
              {
                modelId: 'openrouter:anthropic/claude-sonnet-4.5',
                name: 'OpenRouter · anthropic/claude-sonnet-4.5'
              },
              { modelId: 'openai:gpt-5', name: 'OpenAI · gpt-5' }
            ]
          }
        })
      )
      agent.on('session/set_config_option', (frame) => agent.reply(frame, { configOptions: [] }))
    }
  })
  await rig.acquire({ permissionMode: 'ask' })
  expect(rig.sent('session/set_config_option').map((frame) => frame.params)).toContainEqual(
    expect.objectContaining({ configId: 'edit_approval_policy', value: 'ask' })
  )
  expect(rig.openVerdict()).toBeUndefined()
  expect(rig.started().reportedOptions?.reportedPermissionMode).toBe('ask')
  expect(rig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  expect(rig.adapter.permissionModeRequiresAcquisition(SESSION, 'ask')).toBe(false)
  expect(rig.started().catalogListing?.models.map((model) => model.id)).toEqual([
    'openrouter:anthropic/claude-sonnet-4.5',
    'openai:gpt-5'
  ])

  // Sending works without triggering a restart loop on empty-menu confirmation.
  await sendHello(rig, 'send-1')
  const prompt = await rig.frame('session/prompt')
  rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
  expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)

  // Live permission switch with an empty menu updates the running permission and preserves models.
  await rig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'full-access' })
  expect(rig.sent('session/set_config_option').at(-1)?.params).toMatchObject({
    configId: 'edit_approval_policy',
    value: 'session'
  })
  expect(rig.adapter.runningPermissionMode(SESSION)).toBe('full-access')
  expect(rig.adapter.permissionModeRequiresAcquisition(SESSION, 'full-access')).toBe(false)
  const options = await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })
  expect(options.models.map((model) => model.id)).toEqual([
    'openrouter:anthropic/claude-sonnet-4.5',
    'openai:gpt-5'
  ])
})

it('rejects an empty mode reply when Hermes already declared a mode select', async () => {
  const emptyRejectRig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: [modeOption('session')]
        })
      )
      agent.on('session/set_config_option', (frame) => agent.reply(frame, { configOptions: [] }))
    }
  })
  await emptyRejectRig.acquire({ permissionMode: 'ask' })
  expect(emptyRejectRig.openVerdict()).toBeDefined()
  expect(emptyRejectRig.openVerdict()?.message).toContain('Permission mode could not be confirmed')
})

it('rejects a mode echo that is not the requested value', async () => {
  const mismatchRig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: [modeOption('ask')]
        })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, {
          configOptions: [modeOption(value === 'session' ? 'ask' : value)]
        })
      })
    }
  })
  await mismatchRig.acquire({ permissionMode: 'ask' })
  expect(mismatchRig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  await expect(
    mismatchRig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'full-access' })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(mismatchRig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  expect(mismatchRig.adapter.permissionModeRequiresAcquisition(SESSION, 'full-access')).toBe(true)
})

it('clears a declared mode when a live switch receives an empty reply', async () => {
  const liveEmptyRig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: [modeOption('ask')]
        })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, {
          configOptions: value === 'session' ? [] : [modeOption(value)]
        })
      })
    }
  })
  await liveEmptyRig.acquire({ permissionMode: 'ask' })
  expect(liveEmptyRig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  await expect(
    liveEmptyRig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'full-access' })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(liveEmptyRig.adapter.runningPermissionMode(SESSION)).toBeUndefined()
  expect(liveEmptyRig.adapter.permissionModeRequiresAcquisition(SESSION, 'ask')).toBe(true)
  await expect(
    liveEmptyRig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'full-access' })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(liveEmptyRig.adapter.runningPermissionMode(SESSION)).toBeUndefined()
  expect(liveEmptyRig.adapter.permissionModeRequiresAcquisition(SESSION, 'full-access')).toBe(true)
})

it('syncs to the echoed mode and does not auto-approve the next command', async () => {
  const driftReplies: unknown[] = []
  const driftRig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: [modeOption('session')]
        })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, {
          configOptions: [modeOption(value === 'workspace_session' ? 'ask' : value)]
        })
      })
      agent.on('session/prompt', () => {
        void agent
          .request(9, 'session/request_permission', COMMAND_APPROVAL)
          .then((reply) => driftReplies.push(reply))
      })
    }
  })
  await driftRig.acquire({ permissionMode: 'full-access' })
  expect(driftRig.adapter.runningPermissionMode(SESSION)).toBe('full-access')
  await expect(
    driftRig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'accept-edits' })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(driftRig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  await driftRig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'ask' })
  await sendHello(driftRig, 'send-drift')
  await shownApproval(driftRig)
  expect(driftReplies).toEqual([])
})

it('confirms an approval-policy select that has no mode category', async () => {
  const idOnlyStartupRig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, models: listedModels })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, { configOptions: [interactionMode, approvalPolicy(value)] })
      })
    }
  })
  await idOnlyStartupRig.acquire({ permissionMode: 'ask' })
  expect(idOnlyStartupRig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  expect(idOnlyStartupRig.adapter.permissionModeRequiresAcquisition(SESSION, 'ask')).toBe(false)
})

it('reads the echoed approval policy when it is not the requested mode', async () => {
  const idOnlyMismatchRig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, models: listedModels })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, {
          configOptions: value === 'session' ? [approvalPolicy('workspace_session')] : []
        })
      })
    }
  })
  await idOnlyMismatchRig.acquire({ permissionMode: 'ask' })
  expect(idOnlyMismatchRig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  await expect(
    idOnlyMismatchRig.adapter.applyPermissionMode({
      sessionId: SESSION,
      fence: 1,
      mode: 'full-access'
    })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(idOnlyMismatchRig.adapter.runningPermissionMode(SESSION)).toBe('accept-edits')
  expect(idOnlyMismatchRig.adapter.permissionModeRequiresAcquisition(SESSION, 'ask')).toBe(true)
})

it('stops auto-approving after a live config update leaves full access', async () => {
  const liveDowngradeReplies: unknown[] = []
  const postDowngradeApproval = {
    ...COMMAND_APPROVAL,
    toolCall: {
      ...COMMAND_APPROVAL.toolCall,
      toolCallId: 'perm-check-2',
      title: 'post-downgrade delete: rm -rf /tmp/proj/after-downgrade'
    }
  }
  const liveDowngradeRig = await openAcpAdapterRig({
    spec: HERMES,
    launch: { fullAccess: true },
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: [modeOption('session')] })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, {
          configOptions: [modeOption(value === 'workspace_session' ? 'ask' : value)]
        })
        if (value === 'workspace_session') {
          void agent
            .request(12, 'session/request_permission', COMMAND_APPROVAL)
            .then((reply) => liveDowngradeReplies.push(reply))
        }
      })
      agent.on('session/prompt', () => {
        agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [modeOption('ask')]
          }
        })
        void agent
          .request(11, 'session/request_permission', postDowngradeApproval)
          .then((reply) => liveDowngradeReplies.push(reply))
      })
    }
  })
  await liveDowngradeRig.acquire({ permissionMode: 'full-access' })
  await expect(
    liveDowngradeRig.adapter.applyPermissionMode({
      sessionId: SESSION,
      fence: 1,
      mode: 'accept-edits'
    })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(liveDowngradeRig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  await shownApproval(liveDowngradeRig, 1)
  expect(liveDowngradeReplies).toEqual([])
  await liveDowngradeRig.adapter.applyPermissionMode({
    sessionId: SESSION,
    fence: 1,
    mode: 'full-access'
  })
  expect(liveDowngradeRig.adapter.runningPermissionMode(SESSION)).toBe('full-access')
  await sendHello(liveDowngradeRig, 'send-downgrade')
  const approvals = await shownApproval(liveDowngradeRig, 2)
  expect(approvals.at(-1)?.body).toMatchObject({
    kind: 'approval',
    title: expect.stringContaining('post-downgrade delete')
  })
  expect(liveDowngradeRig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  expect(liveDowngradeReplies).toEqual([])
})

it('rejects a mode echo when the approval policy disagrees with the mode category', async () => {
  const splitControlRig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: [modeOption('ask')]
        })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, {
          configOptions: [modeOption(value), approvalPolicy(value === 'session' ? 'ask' : value)]
        })
      })
    }
  })
  await splitControlRig.acquire({ permissionMode: 'ask' })
  await expect(
    splitControlRig.adapter.applyPermissionMode({
      sessionId: SESSION,
      fence: 1,
      mode: 'full-access'
    })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(splitControlRig.adapter.runningPermissionMode(SESSION)).toBe('ask')
})

it('keeps writing the declared mode id after an empty reply', async () => {
  let attempts = 0
  const retryModeIdRig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: [modeOption('ask')]
        })
      )
      agent.on('session/set_config_option', (frame) => {
        const { configId, value } = z
          .object({ configId: z.string(), value: z.string() })
          .parse(frame.params)
        if (value === 'ask') {
          agent.reply(frame, { configOptions: [modeOption('ask')] })
          return
        }
        attempts += 1
        agent.reply(frame, {
          configOptions: attempts >= 2 && configId === 'mode' ? [modeOption(value)] : []
        })
      })
    }
  })
  await retryModeIdRig.acquire({ permissionMode: 'ask' })
  await expect(
    retryModeIdRig.adapter.applyPermissionMode({
      sessionId: SESSION,
      fence: 1,
      mode: 'accept-edits'
    })
  ).rejects.toThrow('Permission mode could not be confirmed')
  await retryModeIdRig.adapter.applyPermissionMode({
    sessionId: SESSION,
    fence: 1,
    mode: 'accept-edits'
  })
  expect(retryModeIdRig.adapter.runningPermissionMode(SESSION)).toBe('accept-edits')
  expect(
    retryModeIdRig
      .sent('session/set_config_option')
      .map((frame) => z.object({ configId: z.string(), value: z.string() }).parse(frame.params))
      .filter((params) => params.value === 'workspace_session')
      .map((params) => params.configId)
  ).toEqual(['mode', 'mode'])
})

it('stops auto-approving when Hermes reports a lower mode without a menu', async () => {
  const replies: unknown[] = []
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    launch: { fullAccess: true },
    script: (agent) => {
      agent.on('session/new', (frame) => agent.reply(frame, { sessionId: PROVIDER_SESSION }))
      agent.on('session/set_config_option', (frame) => agent.reply(frame, { configOptions: [] }))
      agent.on('session/prompt', () => {
        agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' }
        })
      })
    }
  })
  await rig.acquire({ permissionMode: 'full-access' })
  expect(rig.adapter.runningPermissionMode(SESSION)).toBe('full-access')
  await sendHello(rig, 'send-downgrade')
  await waitFor(() => expect(rig.adapter.runningPermissionMode(SESSION)).toBeUndefined())
  void rig
    .child()
    .agent.request(21, 'session/request_permission', COMMAND_APPROVAL)
    .then((reply) => replies.push(reply))
  await shownApproval(rig)
  expect(replies).toEqual([])
})

it('follows a mode update on the approval policy select', async () => {
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    launch: { fullAccess: true },
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: [approvalPolicy('session')]
        })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, { configOptions: [approvalPolicy(value)] })
      })
    }
  })
  await rig.acquire({ permissionMode: 'full-access' })
  expect(rig.adapter.runningPermissionMode(SESSION)).toBe('full-access')
  rig.child().agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' }
  })
  await waitFor(() => expect(rig.adapter.runningPermissionMode(SESSION)).toBe('ask'))
})

it('keeps advertised models when an unconfirmed mode reply lists nothing', async () => {
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: [modelSelect, effortSelect, modeOption('ask')]
        })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, {
          configOptions: value === 'session' ? [] : [modelSelect, effortSelect, modeOption(value)]
        })
      })
    }
  })
  await rig.acquire({ permissionMode: 'ask' })
  expect(rig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  await expect(
    rig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'full-access' })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(rig.adapter.runningPermissionMode(SESSION)).toBeUndefined()
  const options = await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })
  expect(options.models.map((model) => model.id)).toEqual(['openai:gpt-5'])
  expect(options.current.effort).toBe('high')
})

it('clears both mode and approval selects on an unconfirmed empty reply', async () => {
  const replies: unknown[] = []
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    launch: { fullAccess: true },
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: [modeOption('session'), approvalPolicy('session')]
        })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, {
          configOptions:
            value === 'session' ? [modeOption('session'), approvalPolicy('session')] : []
        })
      })
      agent.on('session/prompt', () => {
        void agent
          .request(9, 'session/request_permission', {
            sessionId: PROVIDER_SESSION,
            toolCall: { toolCallId: 'dual-clear', title: 'Run shell', kind: 'execute' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ]
          })
          .then((reply) => replies.push(reply))
      })
    }
  })
  await rig.acquire({ permissionMode: 'full-access' })
  await expect(
    rig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'ask' })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(rig.adapter.runningPermissionMode(SESSION)).toBeUndefined()
  await sendHello(rig, 'send-dual-clear')
  await waitFor(async () =>
    expect((await rig.rig.rows()).map((row) => row.body.kind)).toContain('approval')
  )
  expect(replies).toEqual([])
})

it('preserves a trailing mode downgrade arriving with the set_config_option reply', async () => {
  const replies: unknown[] = []
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    launch: { fullAccess: true },
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: [modeOption('ask')] })
      )
      agent.on('session/set_config_option', (frame) => {
        const { value } = z.object({ value: z.string() }).parse(frame.params)
        agent.reply(frame, { configOptions: [modeOption(value)] })
        if (value === 'session') {
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: { sessionUpdate: 'config_option_update', configOptions: [modeOption('ask')] }
          })
        }
      })
      agent.on('session/prompt', () => {
        void agent
          .request(14, 'session/request_permission', COMMAND_APPROVAL)
          .then((reply) => replies.push(reply))
      })
    }
  })
  await rig.acquire({ permissionMode: 'ask' })
  await rig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'full-access' })
  expect(rig.adapter.runningPermissionMode(SESSION)).toBe('ask')
  await sendHello(rig, 'send-trailing-downgrade')
  await shownApproval(rig)
  expect(replies).toEqual([])
})

it('leaves own mode on an unconfirmed live switch so returning to own restarts', async () => {
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: [modeOption('ask')] })
      )
      agent.on('session/set_config_option', (frame) => agent.reply(frame, { configOptions: [] }))
    }
  })
  await rig.acquire({ permissionMode: 'own' })
  expect(rig.adapter.runningPermissionMode(SESSION)).toBe('own')
  await expect(
    rig.adapter.applyPermissionMode({ sessionId: SESSION, fence: 1, mode: 'full-access' })
  ).rejects.toThrow('Permission mode could not be confirmed')
  expect(rig.adapter.runningPermissionMode(SESSION)).toBeUndefined()
  expect(rig.adapter.permissionModeRequiresAcquisition(SESSION, 'own')).toBe(true)
})
