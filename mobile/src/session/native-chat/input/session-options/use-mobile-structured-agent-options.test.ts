import { structuredAgentSessionOptionStamp } from '../../../../../../src/shared/agent-session/options/reconciliation/structured-agent-session-option-state'
import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../../../../src/shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../../../../src/shared/agent-session/options/protocol/agent-session-options-result'
import { rememberMobileCreatedStructuredSession } from '../../agent-session/mobile-created-structured-sessions'

import {
  settle,
  OPTIONS,
  deferred,
  optionsClient,
  recordingMutate,
  accepted,
  mountOptions,
  descriptorFor,
  currentValueOf,
  BASE
} from './use-mobile-structured-agent-options.test-fixture'

describe('useMobileStructuredAgentOptions host catalog', () => {
  const HOST_CATALOG: AgentSessionModelCatalogResult = {
    origin: 'probe',
    models: [
      {
        id: 'grok-4',
        label: 'Grok 4',
        isDefault: true,
        defaultEffort: 'high',
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    ],
    fetchedAt: 1,
    listingNamesConfiguredModel: true
  }

  it('does not name the listed default when a chat this phone created is reopened', async () => {
    const sessionId = 'grok-reopened'
    rememberMobileCreatedStructuredSession(sessionId, 'id:wt-1')
    const live = { ...OPTIONS, current: { model: 'gpt-fast', confirmed: ['model'] } }
    const first = optionsClient(
      () => Promise.resolve(live),
      async () => HOST_CATALOG
    )
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const opened = await mountOptions({
      ...BASE,
      agent: 'grok',
      sessionId,
      client: first.client,
      mutate
    })
    await settle()
    await opened.unmount()

    const pending = deferred<AgentSessionOptionsResult>()
    const second = optionsClient(
      () => pending.promise,
      async () => HOST_CATALOG
    )
    const reopened = await mountOptions({
      ...BASE,
      agent: 'grok',
      sessionId,
      client: second.client,
      mutate
    })
    await settle()

    expect(second.methods('agentSession.modelCatalog')[0]?.params).toEqual({
      agent: 'grok',
      sessionId
    })
    expect(currentValueOf(reopened.current().optionSnapshot, 'model')).toBeUndefined()
    pending.resolve(live)
    await settle()
    expect(currentValueOf(reopened.current().optionSnapshot, 'model')).toBe('gpt-fast')
    await reopened.unmount()
  })

  it('keeps a cold Codex picker disabled until the host listing makes literal choices available', async () => {
    const listed = deferred<AgentSessionModelCatalogResult>()
    const catalog = vi.fn(async (params: unknown): Promise<AgentSessionModelCatalogResult> =>
      typeof params === 'object' && params !== null && 'waitForListing' in params
        ? listed.promise
        : { origin: 'unknown', listingInProgress: true }
    )
    const client = optionsClient(() => deferred<AgentSessionOptionsResult>().promise, catalog)
    const { calls, mutate } = recordingMutate(async () =>
      accepted({ key: 'model', value: 'grok-4' }, true)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })
    await settle()

    expect(descriptorFor(harness.current().optionSnapshot, 'model')).toMatchObject({
      settable: false,
      valueSource: 'unknown',
      kind: { type: 'select', choices: [] }
    })

    listed.resolve(HOST_CATALOG)
    await settle()
    const model = descriptorFor(harness.current().optionSnapshot, 'model')
    expect(model?.settable).toBe(true)
    expect(model?.kind.type === 'select' && model.kind.choices.map((c) => c.value)).toEqual([
      'grok-4'
    ])
    await act(async () => {
      expect(await harness.current().setStructuredOption('model', 'grok-4')).toBe(true)
    })
    expect(calls).toEqual([
      { method: 'agentSession.setOption', fields: { key: 'model', value: 'grok-4' } }
    ])
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('grok-4')
    await harness.unmount()
  })
})

it('joins the post-receipt menu read with an unchanged phone option stamp', async () => {
  const initial: AgentSessionOptionsResult = {
    models: [{ id: 'family', label: 'Family', isDefault: false, efforts: [], effortsKnown: false }],
    current: { model: 'family' }
  }
  const ready = deferred<AgentSessionOptionsResult>()
  let reads = 0
  const client = optionsClient(() => (++reads === 1 ? Promise.resolve(initial) : ready.promise))
  const { mutate } = recordingMutate(async () =>
    accepted({ key: 'model', value: 'family', options: { model: 'family' } }, true)
  )
  const harness = await mountOptions({
    ...BASE,
    agent: 'antigravity',
    client: client.client,
    mutate,
    optionStamp: 'family|own'
  })
  expect(descriptorFor(harness.current().optionSnapshot, 'effort')).toBeUndefined()
  await act(async () => {
    expect(await harness.current().setStructuredOption('model', 'family')).toBe(true)
  })
  expect(descriptorFor(harness.current().optionSnapshot, 'model')?.settable).toBe(true)
  await act(async () => {
    ready.resolve({
      ...initial,
      models: [
        {
          id: 'family',
          label: 'Family',
          isDefault: false,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ],
      current: { model: 'family', effort: 'low' }
    })
  })
  await settle()
  expect(currentValueOf(harness.current().optionSnapshot, 'effort')).toBe('low')
  expect(descriptorFor(harness.current().optionSnapshot, 'effort')?.settable).toBe(true)
  await harness.unmount()
})

it('refreshes saved planning intent from the same host status stamp without remounting', async () => {
  let interactionMode: 'default' | 'plan' = 'default'
  const client = optionsClient(async () => ({
    ...OPTIONS,
    current: { interactionMode, acceptedInputSources: { interactionMode: 'saved' } }
  }))
  const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
  const harness = await mountOptions({
    ...BASE,
    client: client.client,
    mutate,
    sendSelection: true,
    optionStamp: structuredAgentSessionOptionStamp({ interactionMode: 'default' })
  })
  expect(harness.current().sendSelection()).toEqual({ selection: { interactionMode: 'default' } })
  interactionMode = 'plan'
  await harness.rerender({
    optionStamp: structuredAgentSessionOptionStamp({ interactionMode: 'plan' })
  })
  await settle()
  expect(harness.current().sendSelection()).toEqual({ selection: { interactionMode: 'plan' } })
  await harness.unmount()
})
