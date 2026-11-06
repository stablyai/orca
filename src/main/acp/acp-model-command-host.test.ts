import { afterEach, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { acpLaunchSpecFor } from './acp-launch-specs'
import type { FakeFrame } from './acp-scripted-agent.test-support'
import { PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import { framesOf, openHostRig, send } from './acp-structured-host.test-support'

afterEach(closeProviderTimelineRigs)

const isCommand = (frame: FakeFrame) => JSON.stringify(frame.params).includes('/model @worker_be')

// The host delivers one send at a time, so a send behind a role's hidden /model waits for it.
it('holds a later send until the role command before it has answered', async () => {
  const grok = acpLaunchSpecFor('grok')!
  const spec = { ...grok, dialect: { ...grok.dialect, modelCommand: OMP_ACP_DIALECT.modelCommand } }
  const held: FakeFrame[] = []
  const { host, rig, ready } = await openHostRig({
    spec,
    script: (agent) => {
      agent.on('session/set_config_option', (frame) =>
        agent.fail(frame, -32603, 'Internal error', { details: 'Unknown ACP model: @worker_be' })
      )
      agent.on('session/prompt', (frame) => {
        if (isCommand(frame)) {
          held.push(frame)
        }
      })
    }
  })
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: 'grok',
        agent: 'grok',
        providerHandle: undefined,
        accountHome: { variable: 'GROK_HOME', path: '/grok' }
      })
    )
  ).toMatchObject({ ok: true })
  await ready()
  const fields = { key: 'model', value: '@worker_be' }
  expect(
    await host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    })
  ).toMatchObject({ ok: true })
  await send(host, 'C on the role')
  await send(host, 'D right after')
  await waitFor(() => expect(held).toHaveLength(1))
  await rig.settle()
  // Only the command has reached OMP; D's controls and prompt wait behind it.
  expect(framesOf(rig.child(), 'session/prompt').map(isCommand)).toEqual([true])
  const writesBefore = framesOf(rig.child(), 'session/set_config_option').length
  rig.child().agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Model set to grok-4.6.' }
    }
  })
  rig.child().agent.reply(held[0]!, { stopReason: 'end_turn' })
  await waitFor(() => expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(2))
  const c = framesOf(rig.child(), 'session/prompt')[1]!
  rig.child().agent.reply(c, { stopReason: 'end_turn' })
  await waitFor(() => expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(3))
  expect(framesOf(rig.child(), 'session/prompt').map(isCommand)).toEqual([true, false, false])
  // D carries the same role, already applied: no second write, no second command.
  expect(framesOf(rig.child(), 'session/set_config_option')).toHaveLength(writesBefore)
  await host.close(SESSION, 'user-close')
})
