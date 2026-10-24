import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import { AcpAgentError } from './acp-errors'

afterEach(closeProviderTimelineRigs)

async function openCodeRig() {
  const rig = await openProviderTimelineRig()
  const translator = new AcpTimelineTranslator({
    sessionId: 'provider-1',
    dialect: OPENCODE_ACP_DIALECT
  })
  const apply = (events: ProviderTimelineEvent[]) => {
    for (const event of events) {
      expect(rig.assembler.apply(event).admission.accepted).toBe(true)
    }
  }
  const update = (body: Record<string, unknown>, at: number) =>
    apply(translator.notification('session/update', { sessionId: 'provider-1', update: body }, at))
  apply(translator.openPrompt('send-1', 1000).events)
  return { rig, translator, apply, update }
}

// OpenCode puts shell output and exit status in rawOutput.metadata.
const bashStart = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call-1',
  title: 'List files',
  kind: 'execute',
  status: 'pending',
  rawInput: { command: 'ls missing', description: 'List files' }
}

describe('OpenCode over ACP', () => {
  it.each([
    { errorName: 'provider.quota', message: undefined },
    { errorName: 'provider.rate-limit', retryAfterMs: 60_000, message: undefined },
    ...[
      'Usage limit reached for 5 hours. Your limit will reset at 2026-10-01 00:00:00',
      'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-01 00:00:00'
    ].map((message) => ({ errorName: 'provider.quota', message }))
  ])('shows usage limits for $errorName', async ({ message: detail, ...data }) => {
    const { rig, translator, apply } = await openCodeRig()
    const message = `Internal error: ${detail ?? 'Rate limit exceeded. Please try again later.'}`
    apply(
      translator.promptFailed(
        'send-1',
        new AcpAgentError(-32603, message, {
          service: 'session',
          ...data
        }),
        1001
      )
    )
    const statuses = (await rig.rows()).filter((row) => row.body.kind === 'status')
    expect(statuses.map((row) => row.body)).toEqual([
      expect.objectContaining({
        kind: 'status',
        tone: 'warning',
        failure: {
          kind: 'usageLimitReached',
          detail: { text: message, audience: 'person' },
          ...('retryAfterMs' in data ? { usageLimit: { resetsAt: 61_001 } } : {})
        }
      })
    ])
    expect((await rig.turns())[0]?.outcome).toBe('failure')
  })

  it.each([
    { status: 402, message: 'Request rejected' },
    { message: 'Payment Required' },
    { message: 'Insufficient balance or no resource package. Please recharge.' },
    { message: 'Credit limit exceeded.' },
    { message: 'Upstream request failed: Insufficient account funds' },
    { message: 'Upstream request failed: Account invoice is overdue' },
    ...[
      'Please add or update your payment method to continue',
      'Your GLM Coding Plan package has expired and is temporarily unavailable. You can resume using it after renewing the subscription on the official website.',
      '[1309][Your GLM Coding Plan package has expired and is temporarily unavailable. You can resume using it after renewing the subscription on the official website.][20260929132151e73af01340d54b58]',
      'Your current subscription plan does not yet include access to glm-5',
      'Your enterprise package has expired. Please contact your enterprise administrator.'
    ].map((message) => ({ message })),
    {
      errorName: 'provider.free-limit',
      message:
        'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.'
    }
  ])('keeps non-reset errors generic: $message', async ({ message: detail, ...data }) => {
    const { rig, translator, apply } = await openCodeRig()
    const message = `Internal error: ${detail}`
    apply(
      translator.promptFailed(
        'send-1',
        new AcpAgentError(-32603, message, {
          service: 'session',
          errorName: 'provider.quota',
          ...data
        }),
        1001
      )
    )
    expect(
      (await rig.rows()).filter((row) => row.body.kind === 'status').map((row) => row.body)
    ).toEqual([{ kind: 'status', tone: 'error', text: message }])
    expect((await rig.turns())[0]?.outcome).toBe('failure')
  })

  it.each([
    {
      label: 'metadata output and exit fallback',
      rawOutput: {
        output: 'ls: missing: No such file or directory\n',
        metadata: { output: 'ls: missing: No such file or directory\n', exit: 1 }
      },
      expected: { exitCode: 1, output: { head: 'ls: missing: No such file or directory\n' } }
    },
    {
      label: 'explicit zero takes precedence over metadata exit three',
      rawOutput: { exitCode: 0, metadata: { exit: 3 } },
      expected: { exitCode: 0 }
    },
    {
      label: 'plain output without metadata',
      rawOutput: 'done',
      expected: { output: { head: 'done' } }
    }
  ])(
    'keeps shell result semantics through the journal: $label',
    async ({ rawOutput, expected }) => {
      const { rig, update } = await openCodeRig()
      update(bashStart, 1001)
      update(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          rawOutput
        },
        1002
      )
      const tool = (await rig.rows()).find((row) => row.body.kind === 'tool-call')?.body
      expect(tool).toMatchObject({ kind: 'tool-call', state: 'completed', ...expected })
    }
  )

  it("shows OpenCode's own permission option names", async () => {
    const { translator, apply, update } = await openCodeRig()
    update(bashStart, 1001)
    const request = translator.request(
      'session/request_permission',
      {
        sessionId: 'provider-1',
        toolCall: { toolCallId: 'call-1', title: 'ls missing', kind: 'execute' },
        options: [
          { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
        ]
      },
      0
    )
    apply(request.events)
    expect(request.presentation?.body).toMatchObject({
      options: [
        { id: 'once', label: 'Allow once' },
        { id: 'always', label: 'Always allow' },
        { id: 'reject', label: 'Reject' }
      ]
    })
    expect(request.presentation?.reply({ kind: 'option', optionId: 'always' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'always' }
    })
  })
})
