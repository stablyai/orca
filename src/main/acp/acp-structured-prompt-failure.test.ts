import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { ACP_LAUNCH_SPECS, type AcpLaunchSpec } from './acp-launch-specs'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello
} from './acp-structured-adapter.test-support'

const promptMeta = z.object({ _meta: z.object({ promptId: z.string() }).optional() })
afterEach(closeProviderTimelineRigs)

function specFor(agent: string): AcpLaunchSpec {
  const spec = ACP_LAUNCH_SPECS.find((entry) => entry.agent === agent)
  if (!spec) {
    throw new Error(`${agent} launch specification missing`)
  }
  return spec
}

/** Fails the first prompt with `code`, after the turn started unless `beforeTurn`. */
async function failFirstPrompt(
  spec: AcpLaunchSpec,
  error: { code: number; message: string; data?: unknown },
  beforeTurn = false
) {
  const rig = await openAcpAdapterRig({
    spec,
    script: (agent) =>
      agent.on('session/prompt', (frame) => {
        if (!beforeTurn) {
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            _meta: promptMeta.parse(frame.params)._meta,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'started' }
            }
          })
        }
        agent.fail(frame, error.code, error.message, error.data)
      })
  })
  await rig.acquire()
  await sendHello(rig, 'first')
  await rig.settle()
  const failures = (await rig.rig.rows()).flatMap(({ body }) =>
    body.kind === 'status' && body.tone === 'error' ? [body] : []
  )
  return { rig, failures }
}

const WORDS = 'Model quota exceeded for this workspace; try again in 5 minutes.'
// OpenCode 1.18.31's recorded answer when its model provider fails: data is only metadata.
const OPENCODE_PROVIDER_ERROR = {
  code: -32603,
  message: 'Internal error: CAPTURE_PROVIDER_400',
  data: { service: 'session', errorName: 'APIError' }
}

const CHECK_THE_CHAT = 'Check the chat before trying again.'

describe.each([
  ['opencode', 'OpenCode'],
  ['grok', 'Grok']
])('%s prompt failure detail', (agent, name) => {
  const spec = specFor(agent)

  // The line names the agent and quotes only readable words; the agent's own words ride Details.
  it.each([
    [
      'data.details',
      { code: -32603, message: 'Internal error', data: { details: WORDS } },
      WORDS,
      `${name} ran into a problem: ${WORDS} ${CHECK_THE_CHAT}`
    ],
    [
      'string data',
      { code: -32603, message: 'Internal error', data: WORDS },
      WORDS,
      `${name} ran into a problem: ${WORDS} ${CHECK_THE_CHAT}`
    ],
    [
      'no data',
      { code: -32603, message: 'Internal error' },
      'Internal error',
      `${name} ran into a problem: Internal error. ${CHECK_THE_CHAT}`
    ],
    [
      'metadata-only data',
      OPENCODE_PROVIDER_ERROR,
      'Internal error: CAPTURE_PROVIDER_400',
      `${name} ran into a problem. ${CHECK_THE_CHAT}`
    ]
  ])('keeps the agent words from %s', async (_label, error, words, line) => {
    const { failures } = await failFirstPrompt(spec, error)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.text).toBe(line)
    expect(failures[0]?.providerFrame?.payload.head).toBe(words)
    expect(failures[0]?.failure?.kind).not.toBe('notSignedIn')
  })

  it('quotes data.details after the sign-in sentence', async () => {
    const { failures } = await failFirstPrompt(spec, {
      code: -32000,
      message: 'Authentication required',
      data: { details: WORDS }
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.failure).toMatchObject({ kind: 'notSignedIn' })
    expect(failures[0]?.text).toMatch(/^Sign in to .+\./)
    expect(failures[0]?.text).toContain(WORDS)
    expect(failures[0]?.text).not.toContain('Authentication required')
  })
})

describe('prompt refused before its turn began', () => {
  const spec = specFor('grok')

  // The rejection keeps the agent's words; its sentence quotes them only when a person can read them.
  it.each([
    [
      { code: -32603, message: 'Internal error', data: { details: WORDS } },
      WORDS,
      `Grok didn't accept this message: ${WORDS}`
    ],
    [
      OPENCODE_PROVIDER_ERROR,
      'Internal error: CAPTURE_PROVIDER_400',
      "Grok didn't accept this message."
    ]
  ])('records the agent words: %j', async (error, text, reason) => {
    const { rig, failures } = await failFirstPrompt(spec, error, true)
    expect(failures).toHaveLength(0)
    const rejected = rig.settled.find((item) => 'state' in item && item.state === 'rejected')
    expect(rejected).toMatchObject({
      clientMessageId: 'first',
      reason,
      rejection: expect.objectContaining({
        kind: 'providerRejected',
        detail: { text, audience: 'person' }
      })
    })
  })
})
