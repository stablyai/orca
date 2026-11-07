import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { providerDiagnosticOf } from '../../shared/agent-session/failures/agent-session-failure'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AcpSignInPromptError } from './acp-errors'
import { ACP_LAUNCH_SPECS } from './acp-launch-specs'
import { AcpSessionRuntime } from './acp-session-runtime'
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
            if (spec.agent === 'opencode' || spec.agent === 'opencode2') {
              // OpenCode 2.0.21, recorded from a temporary home with an invalid dummy key.
              agent.fail(
                frame,
                -32000,
                'Authentication required: provider authentication required',
                {}
              )
            } else {
              agent.fail(
                frame,
                -32000,
                'Authentication required',
                spec.agent === 'grok' ? detail : { message: detail }
              )
            }
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
        if (spec.agent === 'grok') {
          const rejected = rig.settled.find((item) => 'state' in item && item.state === 'rejected')
          expect(rejected && 'reason' in rejected ? rejected.reason : '').toContain(detail)
        }
      }
    }
  })
})

it('ends a running turn signed out when the connection closes for sign-in', async () => {
  const rig = await openAcpAdapterRig({ script: (agent) => agent.on('session/prompt', () => {}) })
  await rig.acquire()
  await sendHello(rig, 'first')
  await rig.frame('session/prompt')
  // Simulate the real connection closing on a stderr sign-in link.
  const internal = 'The agent asked to sign in in a browser'
  AcpSessionRuntime.prototype.close.call(rig.child(), new AcpSignInPromptError(internal))
  await rig.settle()
  expect(rig.settled).toContainEqual(
    expect.objectContaining({
      clientMessageId: 'first',
      state: 'rejected',
      rejection: expect.objectContaining({ kind: 'notSignedIn' })
    })
  )
  // Internal prompt diagnostics must not appear as agent-authored guidance.
  const rejected = rig.settled.find((item) => 'state' in item && item.state === 'rejected')
  expect(rejected && 'reason' in rejected ? rejected.reason : '').not.toContain(internal)
})

it('starts signed out without Orca words when the connection closes for sign-in', async () => {
  const rig = await openAcpAdapterRig({ script: (agent) => agent.on('session/new', () => {}) })
  const starting = rig.acquire()
  await rig.frame('session/new')
  const internal = 'The agent asked to sign in in a browser'
  AcpSessionRuntime.prototype.close.call(rig.child(), new AcpSignInPromptError(internal))
  await starting
  const error = rig.openFailure()
  // Preserve Orca's prompt error when session setup retypes authentication failures.
  expect(error).toMatchObject({ reason: 'notSignedIn' })
  expect(providerDiagnosticOf(error)).toBeUndefined()
})

it.each(ACP_LAUNCH_SPECS)(
  "keeps $agent's sign-in words over log lines it wrote before refusing its start",
  async (spec) => {
    const detail = 'Sign-in credentials are missing.'
    const rig = await openAcpAdapterRig({
      spec,
      script: (agent) =>
        agent.on('session/new', (frame) => {
          rig.child().stderr = 'warn: telemetry endpoint unreachable'
          agent.fail(frame, -32000, detail)
        })
    })
    await rig.acquire()
    expect(rig.openFailure()).toMatchObject({ reason: 'notSignedIn' })
    expect(providerDiagnosticOf(rig.openFailure())).toEqual({ text: detail, audience: 'person' })
  }
)

it.each([
  [
    'No API key found for anthropic.\n\nUse /login, set an API key environment variable, or create /host/agent.db',
    'notSignedIn'
  ],
  // OMP says this for an unresolved launch selector as well as when signed out.
  [
    // OMP 18.2.7, recorded from a signed-out temporary home.
    'No model selected.\n\nUse /login, set an API key environment variable, or create /var/folders/25/xk3307ps7552prstq_2qr7080000gn/T/acp-omp-signed-out-y6rh2dq7/.omp/agent/agent.db\n\nThen use /model to select a model.',
    'modelNotSelected'
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
})
