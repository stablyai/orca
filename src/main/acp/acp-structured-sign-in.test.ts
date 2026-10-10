import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { providerDiagnosticOf } from '../../shared/agent-session-failure'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { agentSessionFailureSentence } from '../../shared/agent-session-failure-words'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { ACP_LAUNCH_SPECS } from './acp-launch-specs'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello
} from './acp-structured-adapter.test-support'

const promptMeta = z.object({ _meta: z.object({ promptId: z.string() }).optional() })
afterEach(closeProviderTimelineRigs)

describe('ACP sign-out at the first prompt', () => {
  it.each(ACP_LAUNCH_SPECS)('classifies $agent before and after acceptance', async (spec) => {
    for (const midTurn of [false, true]) {
      const detail = 'Credentials have expired; sign in on this host.'
      const rig = await openAcpAdapterRig({
        spec,
        script: (agent) =>
          agent.on('session/prompt', (frame) => {
            if (midTurn) {
              agent.notify('session/update', {
                sessionId: PROVIDER_SESSION,
                _meta: promptMeta.parse(frame.params)._meta,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'started' }
                }
              })
            }
            agent.fail(
              frame,
              -32000,
              'Authentication required',
              spec.agent === 'grok' ? detail : { message: detail }
            )
          })
      })
      await rig.acquire()
      await sendHello(rig, 'first')
      await rig.settle()
      if (midTurn || spec.dialect.injectedPromptIdentity !== true) {
        const failures = (await rig.rig.rows()).flatMap(({ body }) =>
          body.kind === 'status' && body.failure ? [body] : []
        )
        expect(failures).toHaveLength(1)
        expect(failures[0]?.failure).toMatchObject({ kind: 'notSignedIn' })
        expect(failures[0]?.text).toContain(
          spec.agent === 'omp' ? 'OMP' : spec.loginCommand.join(' ')
        )
        if (spec.agent === 'grok') {
          expect(failures[0]?.text).toContain(detail)
        }
      } else {
        expect(rig.settled).toContainEqual(
          expect.objectContaining({
            clientMessageId: 'first',
            state: 'rejected',
            rejection: expect.objectContaining({ kind: 'notSignedIn' })
          })
        )
        const rejected = rig.settled.find((item) => 'state' in item && item.state === 'rejected')
        expect(rejected && 'reason' in rejected ? rejected.reason : '').toContain(
          spec.agent === 'omp' ? 'OMP' : spec.loginCommand.join(' ')
        )
        if (spec.agent === 'grok') {
          expect(rejected && 'reason' in rejected ? rejected.reason : '').toContain(detail)
        }
      }
    }
  })
})

it.each(ACP_LAUNCH_SPECS)(
  'preserves $agent startup auth classification and its detail',
  async (spec) => {
    const detail = 'Sign-in credentials are missing.'
    const rig = await openAcpAdapterRig({
      spec,
      script: (agent) => agent.on('session/new', (frame) => agent.fail(frame, -32000, detail))
    })
    const error = await rig.acquire().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AgentSessionAcquisitionRefusal)
    expect(error).toMatchObject({ reason: 'notSignedIn' })
    expect(providerDiagnosticOf(error)).toEqual({ text: detail, audience: 'person' })
    const fact = providerStartupFailureFact(error)
    expect(fact.detail?.text).toBe(detail)
    expect(agentSessionFailureSentence(fact, 'row', { agentName: spec.agent })).toContain(detail)
  }
)

it.each([
  [
    'No API key found for anthropic.\n\nUse /login, set an API key environment variable, or create /host/agent.db',
    'notSignedIn'
  ],
  [
    'No model selected.\n\nUse /login, set an API key environment variable, or create /host/agent.db\n\nThen use /model to select a model.',
    'notSignedIn'
  ],
  ['No model selected', undefined],
  ['Rate limit exceeded', undefined],
  ['Network connection failed', undefined],
  ['No API key found elsewhere', undefined]
] as const)('reads OMP internal-error detail without guessing auth: %s', async (detail, kind) => {
  const spec = ACP_LAUNCH_SPECS.find((entry) => entry.agent === 'omp')
  if (!spec) {
    throw new Error('OMP launch specification missing')
  }
  const rig = await openAcpAdapterRig({
    spec,
    script: (agent) =>
      agent.on('session/prompt', (frame) =>
        agent.fail(frame, -32603, 'Internal error', { details: detail })
      )
  })
  await rig.acquire()
  await sendHello(rig, 'first')
  await rig.settle()
  const row = (await rig.rig.rows()).find(
    ({ body }) => body.kind === 'status' && body.tone === 'error'
  )
  expect(row?.body.kind === 'status' ? row.body.failure?.kind : undefined).toBe(kind)
  expect(row?.body.kind === 'status' ? row.body.text : '').toContain(detail)
})
