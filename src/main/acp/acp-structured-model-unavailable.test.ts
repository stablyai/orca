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
import { acpLaunchSpecFor } from './acp-launch-specs'
import {
  GROK_CONFIG_OPTIONS,
  PROVIDER_SESSION,
  waitFor
} from './acp-structured-adapter.test-support'
import { framesOf, openHostRig, send } from './acp-structured-host.test-support'
import { z } from 'zod'

// CLI source responses: Grok resolve_model_id; OMP #setModelById through RpcConnection's error wrapper.
const refusals = [
  {
    agent: 'grok',
    name: 'Grok',
    code: -32602,
    message: 'Invalid params',
    data: 'unknown model id',
    kind: 'providerRejected',
    modelRefusal: true,
    reason: "Grok didn't accept this message: unknown model id."
  },
  {
    agent: 'omp',
    name: 'OMP',
    code: -32603,
    message: 'Internal error',
    data: { details: 'Unknown ACP model: retired' },
    // The option refuses an unlisted value, so OMP's own /model (builtin-modes.ts) gets it next.
    commandReply:
      'Unknown model: retired. Use ACP `session/setModel` for picker-driven selection or list available models with /model.',
    kind: 'modelUnavailable',
    modelRefusal: true,
    reason: "OMP couldn't use retired. Pick another model and send again."
  },
  {
    agent: 'grok',
    name: 'Grok authentication required',
    code: -32000,
    message: 'Authentication required',
    data: undefined,
    modelRefusal: false,
    kind: 'notSignedIn',
    reason: 'notSignedIn'
  },
  {
    agent: 'grok',
    name: 'Grok temporarily unavailable',
    modelRefusal: false,
    code: -32603,
    message: 'Internal error',
    data: { details: 'Provider temporarily unavailable' },
    kind: 'providerRejected',
    reason: "Grok didn't accept this message: Provider temporarily unavailable."
  },
  {
    agent: 'omp',
    name: 'OMP missing session',
    modelRefusal: false,
    code: -32002,
    message: 'Resource not found: acp-session-1',
    data: { uri: 'acp-session-1' },
    kind: 'providerRejected',
    reason: "OMP didn't accept this message: Resource not found: acp-session-1."
  }
] as const

afterEach(closeProviderTimelineRigs)

it.each(refusals)(
  '$name preserves the selected model and the actual rejection',
  async (failure) => {
    const spec = acpLaunchSpecFor(failure.agent)!
    const { host, rig, store, ready } = await openHostRig({
      spec,
      script: (agent) => {
        agent.on('session/prompt', (frame) => {
          const text = JSON.stringify(frame.params)
          if ('commandReply' in failure && text.includes('/model retired')) {
            agent.notify('session/update', {
              sessionId: PROVIDER_SESSION,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: failure.commandReply }
              }
            })
            agent.reply(frame, { stopReason: 'end_turn' })
          }
        })
        agent.on('session/set_config_option', (frame) => {
          const { configId, value } = z
            .object({ configId: z.string(), value: z.string() })
            .parse(frame.params)
          if (value === 'retired') {
            agent.fail(frame, failure.code, failure.message, failure.data)
          } else {
            agent.reply(frame, {
              configOptions: GROK_CONFIG_OPTIONS.map((option) =>
                option.id === configId ? { ...option, currentValue: value } : option
              )
            })
          }
        })
      }
    })
    const attached = await host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: failure.agent,
        agent: failure.agent,
        providerHandle: undefined,
        accountHome: {
          variable: failure.agent === 'grok' ? 'GROK_HOME' : 'PI_CODING_AGENT_DIR',
          path: '/grok'
        }
      })
    )
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
    await ready()
    const pick = async (value: string) => {
      const fields = { key: 'model', value }
      expect(
        await host.setOption(CALLER, {
          envelope: envelope('agentSession.setOption', fields),
          ...fields
        })
      ).toMatchObject({ ok: true })
    }
    // Only the hidden model command may reach OMP; the refused messages never do.
    const commands = () =>
      framesOf(rig.child(), 'session/prompt').filter((frame) =>
        JSON.stringify(frame.params).includes('/model retired')
      )
    await pick('retired')
    const attempts = failure.modelRefusal ? ['first attempt', 'second attempt'] : ['first attempt']
    for (const text of attempts) {
      const messageId = await send(host, text)
      await waitFor(async () => {
        const snapshot = await host.journalSnapshot(SESSION)
        expect(
          snapshot.submissions.find((entry) => entry.clientMessageId === messageId)
        ).toMatchObject({
          dispatchState: 'rejected',
          rejection: { kind: failure.kind },
          ...(failure.kind === 'notSignedIn' ? {} : { reason: failure.reason })
        })
        if (failure.kind === 'notSignedIn') {
          expect(
            snapshot.submissions.find((entry) => entry.clientMessageId === messageId)?.reason
          ).toContain('Sign in')
        }
      })
      expect(store.getRecord(SESSION)?.options?.model).toBe('retired')
      expect((await host.readOptions(SESSION, { readsWithoutModel: true })).current.model).toBe(
        'retired'
      )
      expect(commands()).toHaveLength(framesOf(rig.child(), 'session/prompt').length)
    }
    const failed = await host.journalSnapshot(SESSION)
    expect(
      failed.submissions.filter((entry) => entry.rejection?.kind === failure.kind)
    ).toHaveLength(attempts.length)
    const rows = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    expect(
      rows.filter((row) => row.body.kind === 'status' && row.body.failure?.kind === failure.kind)
    ).toHaveLength(0)
    // The hidden command's reply is OMP's raw text: never a row, a turn or unread.
    expect(JSON.stringify(rows)).not.toContain('Unknown model:')
    if (!failure.modelRefusal) {
      await host.close(SESSION, 'user-close')
      return
    }
    await pick('grok-4.7')
    await send(host, 'after a new pick')
    const sent = commands().length
    await waitFor(() => expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(sent + 1))
    const prompt = framesOf(rig.child(), 'session/prompt').at(-1)!
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    expect(store.getRecord(SESSION)?.options?.model).toBe('grok-4.7')
    await host.close(SESSION, 'user-close')
  }
)
