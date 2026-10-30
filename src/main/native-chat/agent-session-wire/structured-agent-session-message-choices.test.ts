import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { sessionFor } from '../../claude/claude-structured-dispatch-test-support'
import type { ClaudeSession } from '../../claude/structured/claude-structured-session-state'
import { dispatchClaudeMessage } from '../../claude/claude-structured-message-options'
import { createClaudeUserMessageQueue } from '../../claude/claude-agent-sdk-user-message-queue'
import { ClaudeControlRequestError } from '../../claude/claude-stream-json-connection'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-submission-schema'
import {
  structuredAgentSessionRecordedRejectionParts,
  structuredAgentSessionAttemptFailureParts
} from '../../../shared/structured-agent-session-rejection-words'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import {
  providerDiagnostic,
  readWholeAgentSessionFailureFact,
  withProviderDiagnostic
} from '../../../shared/agent-session-failure'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { AgentSessionOptionRejectedError } from './structured-agent-session-option-error'

const { agentSessionWriteNoticeText } = await vi.importActual<{
  agentSessionWriteNoticeText: typeof agentSessionWriteNoticeEnglish
}>('../../../renderer/src/components/native-chat/agent-session-write-notice-text')

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

async function pickModel(model: string): Promise<void> {
  const fields = { key: 'model', value: model }
  const result = await rig.host.setOption(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
    ...fields
  })
  expect(result).toMatchObject({ ok: true })
}

it('keeps the first accepted choice through opening and saves a later pick for the next send', async () => {
  await rig.dispose()
  rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
  const first = rig.send('first', undefined, { carried: { model: 'model-a' } })
  expect(await first.result).toMatchObject({ ok: true })
  await pickModel('model-b')
  const second = rig.send('second')
  expect(await second.result).toMatchObject({ ok: true })
  expect(rig.setOption).not.toHaveBeenCalled()
  await rig.proveStart()
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  expect(rig.dispatch.mock.calls[0]?.[0].executionOptions).toEqual({ model: 'model-a' })
  await rig.settleAccepted(first.id, 'a')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual({ model: 'model-b' })
  expect(rig.store.getRecord(SESSION)?.options?.model).toBe('model-b')
})

it('keeps the model and effort a chat with none saved first ran, after its config moves', async () => {
  await rig.dispose()
  const agent = { restartable: true as const, reportsModel: 'gpt-ran', reportsEffort: 'xhigh' }
  rig = await createQueuedMessageTestRig(agent)
  rig.dispatch.mockResolvedValueOnce({
    state: 'admitted',
    ranOptions: { model: 'gpt-ran', effort: 'xhigh' }
  })
  const first = rig.send('first')
  expect(await first.result).toMatchObject({ ok: true })
  await eventually(() =>
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'gpt-ran', effort: 'xhigh' })
  )
  await rig.settleAccepted(first.id, 'a')
  Object.assign(agent, { reportsModel: 'gpt-new', reportsEffort: 'low' })
  await rig.restartHostProcess()
  const second = rig.send('second')
  expect(await second.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual({
    model: 'gpt-ran',
    effort: 'xhigh'
  })
})

it('records what a later readback reports when the start named only a filled-in default', async () => {
  // Model Claude’s delayed settings readback after startup without a model.
  rig.dispatch.mockResolvedValueOnce({ state: 'admitted', ranOptions: {} })
  const first = rig.send('first')
  expect(await first.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  expect(rig.store.getRecord(SESSION)?.options).toBeUndefined()
  await rig.settleAccepted(first.id, 'a')
  const preparation = Promise.withResolvers<never>()
  rig.dispatch.mockImplementationOnce(() => preparation.promise)
  await rig.send('rejected before preparation').result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  await rig.host.handleAdapterEvent({
    type: 'options-reported',
    sessionId: SESSION,
    fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
    acquisitionGeneration: 'generation-1',
    reportedOptions: { model: 'opus[1m]', effort: 'high' }
  })
  preparation.reject(new Error('content preparation failed'))
  await eventually(() =>
    expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'opus[1m]' })
  )
})

it('saves no model for an agent that reports options but gives no evidence of what ran', async () => {
  // As OpenCode: its session/new names one model and a config update moments later the one it runs.
  await rig.dispose()
  rig = await createQueuedMessageTestRig({ restartable: true, reportsModel: 'startup-model' })
  const first = rig.send('first')
  expect(await first.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  await rig.host.handleAdapterEvent({
    type: 'options-reported',
    sessionId: SESSION,
    fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
    acquisitionGeneration: 'generation-1',
    reportedOptions: { model: 'live-model' }
  })
  await rig.settleAccepted(first.id, 'a')
  const second = rig.send('second')
  expect(await second.result).toMatchObject({ ok: true })
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual({})
  expect(rig.store.getRecord(SESSION)?.options).toBeUndefined()
})

it('rejects a refused choice before prompt input and leaves the next pick saved', async () => {
  await pickModel('model-b')
  rig.dispatch.mockRejectedValueOnce(
    withProviderDiagnostic(
      new AgentSessionOptionRejectedError('model-a is unavailable'),
      providerDiagnostic('model-a is unavailable', 'person')
    )
  )
  const first = rig.send('first', undefined, { carried: { model: 'model-a' } })
  expect(await first.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await rig.submission(first.id)).toMatchObject({
      dispatchState: 'rejected',
      reason: expect.stringContaining('model-a is unavailable')
    })
  )
  expect(rig.dispatch).toHaveBeenCalledOnce()
  expect(rig.store.getRecord(SESSION)?.options?.model).toBe('model-b')
})

it('carries Claude effort validation through the SDK queue and saved desktop/phone rejection, then recovers', async () => {
  await rig.dispose()
  rig = await createQueuedMessageTestRig({ agent: 'claude', restartable: true })
  const queue = createClaudeUserMessageQueue()
  const prompts: SDKUserMessage[] = []
  const pump = (async () => {
    for await (const message of queue.messages) {
      prompts.push(message)
    }
  })()
  const session = sessionFor(
    vi.fn((...args: Parameters<ClaudeSession['connection']['send']>) => {
      const message = z
        .strictObject({
          type: z.literal('user'),
          uuid: z.templateLiteral([
            z.string(),
            '-',
            z.string(),
            '-',
            z.string(),
            '-',
            z.string(),
            '-',
            z.string()
          ]),
          session_id: z.string(),
          parent_tool_use_id: z.null(),
          message: z.strictObject({
            role: z.literal('user'),
            content: z.array(z.strictObject({ type: z.literal('text'), text: z.string() }))
          })
        })
        .parse(args[0])
      return queue.push(message, args[1])
    })
  )
  session.providerSessionId = THREAD
  const nativeWrite = vi.fn().mockResolvedValue(undefined)
  Object.assign(session.connection, {
    applyFlagSettings: nativeWrite,
    getSettings: () => new Promise(() => {})
  })
  rig.dispatch.mockImplementation((input) =>
    dispatchClaudeMessage(session, input, undefined, { warn: vi.fn(), error: vi.fn() })
  )
  const pickEffort = async (value: string) => {
    const fields = { key: 'effort', value }
    expect(
      await rig.host.setOption(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
  }
  try {
    await pickEffort('banana')
    const invalid = rig.send('invalid effort')
    expect(await invalid.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(invalid.id))?.dispatchState).toBe('rejected')
    )
    const saved = await rig.submission(invalid.id)
    if (!saved) {
      throw new Error('missing rejected submission')
    }
    const correction =
      'Claude effort is invalid; choose low, medium, high, xhigh, or max and send again.'
    expect(AgentJournalSubmissionSchema.parse(saved)).toMatchObject({
      options: { effort: 'banana' },
      rejection: { kind: 'claudeEffortInvalid' },
      reason: correction
    })
    expect(saved.rejection).toEqual({ kind: 'claudeEffortInvalid' })
    expect(nativeWrite).not.toHaveBeenCalled()
    expect(prompts).toEqual([])
    expect(session.dispatchWaiters).toEqual([])
    await rig.restartHostProcess()
    expect(await rig.submission(invalid.id)).toEqual(saved)
    expect(
      agentSessionWriteNoticeText(
        structuredAgentSessionRecordedRejectionParts(saved, { agentName: 'Claude' }, [])
      )
    ).toBe(correction)
    expect(
      agentSessionWriteNoticeEnglish(
        structuredAgentSessionAttemptFailureParts(
          { kind: 'rejected', reason: saved.reason },
          { agentName: 'Claude', retryControl: true },
          readWholeAgentSessionFailureFact(saved.rejection)
        )
      )
    ).toBe(correction)

    await pickEffort('high')
    nativeWrite.mockRejectedValueOnce(
      new ClaudeControlRequestError('apply_flag_settings', 'Provider declined this setting')
    )
    const provider = rig.send('provider refusal', undefined, { carried: { effort: 'medium' } })
    await provider.result
    await eventually(async () =>
      expect((await rig.submission(provider.id))?.rejection).toEqual({
        kind: 'providerRejected',
        detail: { text: 'Provider declined this setting', audience: 'person' }
      })
    )
    expect((await rig.submission(provider.id))?.reason).toBe(
      "Claude didn't accept this message: Provider declined this setting."
    )
    nativeWrite.mockRejectedValueOnce(new Error('private internal implementation detail'))
    const internal = rig.send('internal refusal', undefined, { carried: { effort: 'low' } })
    await internal.result
    await eventually(async () =>
      expect(await rig.submission(internal.id)).toMatchObject({
        rejection: { kind: 'providerRejected' },
        reason: "Claude didn't accept this message."
      })
    )
    expect((await rig.submission(internal.id))?.rejection).toEqual({ kind: 'providerRejected' })
    expect(prompts).toEqual([])
    const valid = rig.send('valid effort')
    expect(await valid.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(valid.id))?.handedOverAt).toBeDefined()
    )
    expect(nativeWrite.mock.calls.map(([flags]) => flags)).toEqual([
      { effortLevel: 'medium' },
      { effortLevel: 'low' },
      { effortLevel: 'high' },
      { fastMode: false }
    ])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.message.content).toEqual([{ type: 'text', text: 'valid effort' }])
    expect(session.appliedInputOptions.get('effort')).toBe('high')
    expect(rig.store.getRecord(SESSION)?.options?.effort).toBe('high')
  } finally {
    queue.end()
    await pump
  }
})

it('uses each send’s captured choices when two messages arrive during startup', async () => {
  const releaseStart = rig.holdNextStart()
  const first = rig.send('first', undefined, {
    carried: { model: 'model-a', effort: 'high' }
  })
  const second = rig.send('second', undefined, {
    carried: { model: 'model-b', effort: 'low' }
  })
  expect(await first.result).toMatchObject({ ok: true })
  expect(await second.result).toMatchObject({ ok: true })
  expect(rig.dispatch).not.toHaveBeenCalled()
  releaseStart()
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  await rig.settleAccepted(first.id, 'a')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls.map(([input]) => input.executionOptions)).toEqual([
    { model: 'model-a', effort: 'high' },
    { model: 'model-b', effort: 'low' }
  ])
  expect(rig.setOption).not.toHaveBeenCalled()
})

it('keeps a draft’s accepted choices through a host restart and Send now', async () => {
  const working = await rig.workingSend()
  const choices = { model: 'model-b', effort: 'low' }
  const queued = await rig.send('use these choices', 'queue-if-active', {
    carried: choices
  }).result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  const draftId = queued.value.queued.messageId
  await rig.restartHostProcess()
  expect(await rig.host.history({ sessionId: SESSION, direction: 'tail' })).toMatchObject({
    ok: true
  })
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  expect(journal?.queuedMessages.get(draftId)?.options).toEqual(choices)
  await rig.settleAccepted(working, 'a')
  expect(await rig.sendNow(draftId)).toMatchObject({ ok: true })
  expect((await rig.handoff(draftId))?.options).toEqual(choices)
})

it('steers a matching choice but holds a different one for a new turn', async () => {
  const choices = { model: 'model-a', effort: 'high' }
  const first = rig.send('first', undefined, { carried: choices })
  await first.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  await rig.settleAccepted(first.id, 'a')
  rig
    .providerEvents()
    .appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-a', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-a', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await rig.host.flushStreamedEvents(SESSION)

  const extras = { ...choices, personality: 'friendly', serviceTier: 'priority', fastMode: 'true' }
  const matching = rig.send('same choices', undefined, { carried: extras })

  await matching.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1]?.[0].executionOptions).toEqual(extras)
  await rig.host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId: matching.id,
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-a', ordinal: 1 }
  })
  const other = rig.send('other choices', undefined, { carried: { effort: 'low' } })
  await other.result
  expect(rig.dispatch).toHaveBeenCalledTimes(2)

  rig
    .providerEvents()
    .appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-a', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-a', state: 'completed' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await rig.host.flushStreamedEvents(SESSION)
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(3))
  expect(rig.dispatch.mock.calls[2]?.[0].executionOptions).toEqual({
    model: 'model-a',
    effort: 'low'
  })
})

it.each(['before', 'during', 'after'])(
  'uses only a model observed after input, including reports %s finalization',
  async (when) => {
    await rig.dispose()
    rig = await createQueuedMessageTestRig({ reportsModel: 'old-model', reportsEffort: 'high' })
    const report = (model: string) =>
      rig.host.handleAdapterEvent({
        type: 'options-reported',
        sessionId: SESSION,
        fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
        acquisitionGeneration: 'generation-1',
        reportedOptions: { model, effort: 'low', fastMode: true, fastModeState: 'on' }
      })
    rig.dispatch.mockImplementationOnce(async (input) => {
      if (when === 'before') {
        await report('previous-model')
      }
      input.onInputPreparation?.()
      input.onExecutionSnapshot?.()
      if (when === 'during') {
        await report('actual-model')
      }
      return { state: 'admitted', ranOptions: {} }
    })
    const first = rig.send('first')
    expect(await first.result).toMatchObject({ ok: true })
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledOnce())
    if (when !== 'during') {
      expect(rig.store.getRecord(SESSION)?.options).toBeUndefined()
      await report('actual-model')
    }
    await eventually(() =>
      expect(rig.store.getRecord(SESSION)?.options).toEqual({ model: 'actual-model' })
    )
  }
)
