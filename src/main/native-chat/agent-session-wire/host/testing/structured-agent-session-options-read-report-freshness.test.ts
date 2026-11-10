import { expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionMutationContext } from '../../operations/structured-agent-session-mutation-context'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from '../structured-agent-session-host-types'
import { readStructuredAgentSessionOptions } from '../../options/structured-agent-session-options-read'
import { noteStructuredAgentSessionOptionPick } from '../../options/structured-agent-session-option-intent'
import {
  hostTestCatalogReadOperation,
  hostTestOptionsReadStore,
  hostTestRestingOptionsJournal,
  hostTestRestingOptionsRecord,
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'
import { appendUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'

const RESPONSE_REPORT = { model: 'opus[1m]', reportedModel: 'claude-opus-4-8' }
// Claude's confirmed init model stands in for a report when no response named one.
const CONFIRMED_INIT = { model: 'opus[1m]', confirmed: ['model'] }

function claudeOptionsRead(answer: Record<string, unknown> = RESPONSE_REPORT) {
  const record = {
    ...hostTestRestingOptionsRecord('session-1'),
    provider: 'claude',
    options: { model: 'opus[1m]' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader and pick counter use only the child's identity, fence and phase.
  const child = { fence: 2, phase: 'ready' } as unknown as StructuredAgentSessionProviderChild
  const conversation = {
    child,
    params: { provider: 'claude' },
    journal: hostTestRestingOptionsJournal()
  }
  // Picks serialize with the live read, so they can land only after it, as the answer is assembled.
  const entered = Promise.withResolvers<void>()
  const assembled = Promise.withResolvers<void>()
  const home: AgentSessionModelCatalogResult = { origin: 'probe', fetchedAt: 1, models: [] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: picks and the reader read only the session's current child.
  const session = { child } as unknown as StructuredAgentSessionHostSession
  const sessions = new Map([['session-1', session]])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real reader accesses only these injected ports; no provider process is launched.
  const context = {
    deps: {
      adapter: {
        readOptions: async () => ({
          models: [],
          current: answer
        })
      },
      agents: { definition: () => null, capabilities: () => null },
      store: hostTestOptionsReadStore(() => record),
      modelCatalog: {
        captureRead: hostTestCatalogReadOperation,
        read: async () => home
      }
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => conversation,
    conversation: async () => {
      entered.resolve()
      await assembled.promise
      return conversation
    },
    sessions
  } as unknown as StructuredAgentSessionMutationContext
  const pick = (model: string) => {
    record.options.model = model
    noteStructuredAgentSessionOptionPick(
      { deps: { adapter: {} }, sessions },
      { sessionId: 'session-1', fence: 2 },
      { key: 'model', value: model },
      true
    )
  }
  /** Run `during` while the read is between its live snapshot and its answer. */
  const read = async (during: () => void = () => {}) => {
    const answer = readStructuredAgentSessionOptions(context, 'session-1', {
      readsWithoutModel: true
    })
    await entered.promise
    during()
    assembled.resolve()
    return (await answer).current
  }
  return { read, pick, sessions, session }
}

it('keeps a live fallback report that no pick has replaced', async () => {
  expect(await claudeOptionsRead(CONFIRMED_INIT).read()).toMatchObject({
    reportedModel: 'opus[1m]'
  })
  expect(await claudeOptionsRead().read()).toMatchObject({
    model: 'opus[1m]',
    reportedModel: 'claude-opus-4-8'
  })
})

it.each([
  ['picks back to the same model', ['sonnet', 'opus[1m]'], RESPONSE_REPORT],
  ['re-picks the shown model', ['opus[1m]'], RESPONSE_REPORT],
  ['picks back while only the init model confirms', ['sonnet', 'opus[1m]'], CONFIRMED_INIT]
])(
  'drops a report captured before the user %s while the read is in flight',
  async (_, models, answer) => {
    const host = claudeOptionsRead(answer)
    const current = await host.read(() => models.forEach((model) => host.pick(model)))
    expect(current.model).toBe('opus[1m]')
    expect(current.reportedModel).toBeUndefined()
  }
)

it('drops a report from a child that ended or was replaced while the read was in flight', async () => {
  for (const next of [null, { fence: 3, phase: 'ready' }]) {
    const host = claudeOptionsRead()
    const current = await host.read(() => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only child identity matters to the reader.
      host.sessions.set('session-1', {
        ...host.session,
        child: next
      } as unknown as StructuredAgentSessionHostSession)
    })
    expect(current.reportedModel).toBeUndefined()
  }
})

it.each([
  [
    'retires the report when the user picks back to it',
    QUEUED_RIG_CALLER,
    ['sonnet', 'opus[1m]'],
    undefined
  ],
  [
    'keeps the report through an old client empty no-op',
    { ...QUEUED_RIG_CALLER, readsOptionsWithoutModel: false },
    [''],
    'claude-opus-4-8'
  ]
] as const)(
  'after a usage-limited turn, a pick made while recovery choices load %s',
  async (_, caller, models, reportedModel) => {
    const rig = await createQueuedMessageTestRig({ agent: 'claude' })
    try {
      const pick = async (value: string) => {
        const fields = { key: 'model', value }
        return rig.host.setOption(caller, {
          envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
          ...fields
        })
      }
      expect(await pick('opus[1m]')).toMatchObject({ ok: true })
      rig.host.deps.adapter.readOptions = async () => ({ models: [], current: RESPONSE_REPORT })
      const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      await appendUsageLimitedTurn(journal, NOW, 'quota')
      const recovering = Promise.withResolvers<void>()
      const released = Promise.withResolvers<undefined>()
      rig.host.deps.resolveLaunchEnv = () => {
        recovering.resolve()
        return released.promise
      }
      const answer = rig.host.readOptions(SESSION)
      await recovering.promise
      for (const model of models) {
        expect(await pick(model)).toMatchObject({ ok: true })
      }
      released.resolve(undefined)
      const { current } = await answer
      expect(current.model).toBe('opus[1m]')
      expect(current.reportedModel).toBe(reportedModel)
    } finally {
      await rig.dispose()
    }
  }
)
