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
  hostTestRestingOptionsRecord
} from './structured-agent-session-host-test-data'

function claudeOptionsRead() {
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
          current: { model: 'opus[1m]', reportedModel: 'claude-opus-4-8' }
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
  const pick = (model: string, saved = true) => {
    if (saved) {
      record.options.model = model
    }
    noteStructuredAgentSessionOptionPick(
      { deps: { adapter: {} }, sessions },
      { sessionId: 'session-1', fence: 2 },
      { key: 'model', value: model },
      saved
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

it('keeps a live fallback report that no pick has replaced, including an old client empty no-op', async () => {
  const host = claudeOptionsRead()
  expect(await host.read(() => host.pick('', false))).toMatchObject({
    model: 'opus[1m]',
    reportedModel: 'claude-opus-4-8'
  })
})

it.each([
  ['picks back to the same model', ['sonnet', 'opus[1m]']],
  ['re-picks the shown model', ['opus[1m]']]
])('drops a report captured before the user %s while the read is in flight', async (_, models) => {
  const host = claudeOptionsRead()
  const current = await host.read(() => models.forEach((model) => host.pick(model)))
  expect(current.model).toBe('opus[1m]')
  expect(current.reportedModel).toBeUndefined()
})

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
