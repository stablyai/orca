import { structuredAgentSessionOptionStamp } from '../../../../../src/shared/agent-session/options/structured-agent-session-option-state'
import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionResult
} from '../../../../../src/shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../../../src/shared/agent-session/options/agent-session-options-result'
import type { StructuredAgentSessionMutationResult } from '../agent-session/mobile-structured-agent-session-rpc'
import { rememberMobileCreatedStructuredSession } from '../agent-session/mobile-created-structured-sessions'

import {
  settle,
  OPTIONS,
  FAST_OPTIONS,
  FAST_OPTIONS_ON,
  deferred,
  optionsClient,
  queuedReads,
  recordingMutate,
  accepted,
  mountOptions,
  descriptorFor,
  currentValueOf,
  BASE
} from './use-mobile-structured-agent-options.test-fixture'

describe('useMobileStructuredAgentOptions images', () => {
  it('keeps the answer through a pick made during the read', async () => {
    const stale = deferred<AgentSessionOptionsResult>()
    const first = optionsClient(queuedReads(OPTIONS))
    const reconnected = optionsClient(() => stale.promise)
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, agent: 'opencode', client: first.client, mutate })
    await harness.rerender({ client: reconnected.client })
    await act(async () => {
      await harness.current().setStructuredOption('model', 'gpt-fast')
    })
    expect(harness.current().acceptsImages).toBe(false)
    await act(async () => {
      stale.resolve({ ...OPTIONS, acceptsImages: true })
    })
    await settle()
    expect(harness.current().acceptsImages).toBe(true)
    await harness.unmount()
  })

  it("never shows one chat's answer on the next while its read is in flight", async () => {
    const next = deferred<AgentSessionOptionsResult>()
    let reads = 0
    const client = optionsClient(() =>
      reads++ === 0 ? Promise.resolve({ ...OPTIONS, acceptsImages: true }) : next.promise
    )
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, agent: 'grok', client: client.client, mutate })
    expect(harness.current().acceptsImages).toBe(true)
    await harness.rerender({ sessionId: 'session-2' })
    expect(harness.current().acceptsImages).toBe(false)
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions pending picks', () => {
  it('holds a repeat of an option on its way but lets another option go, as desktop does', async () => {
    const client = optionsClient(queuedReads(FAST_OPTIONS, FAST_OPTIONS_ON))
    const inFlight = deferred<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>()
    const { calls, mutate } = recordingMutate(async (call) =>
      call === 0 ? inFlight.promise : accepted({ key: 'fastMode', value: 'true' }, false)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    let firstWrite: Promise<boolean> | null = null
    await act(async () => {
      firstWrite = harness.current().setStructuredOption('effort', 'high')
    })
    expect(calls).toHaveLength(1)
    expect(harness.current().pendingOptionId).toBe('effort')

    let repeat: boolean | null = null
    await act(async () => {
      repeat = await harness.current().setStructuredOption('effort', 'medium')
    })
    expect(repeat).toBe(false)
    expect(calls).toHaveLength(1)

    let other: boolean | null = null
    await act(async () => {
      other = await harness.current().setStructuredOption('fastMode', true)
    })
    expect(other).toBe(true)
    expect(calls).toHaveLength(2)

    await act(async () => {
      inFlight.resolve(accepted({ key: 'effort', value: 'high' }, false))
      await firstWrite
    })
    await settle()
    expect(await firstWrite).toBe(true)
    expect(harness.current().pendingOptionId).toBeNull()
    await harness.unmount()
  })
})

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
    expect(calls).toEqual([])

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

it('phone retains a queried seed-catalog base across its fence until later metadata arrives', async () => {
  const catalog = deferred<AgentSessionModelCatalogResult>()
  let reads = 0
  const client = optionsClient(
    () =>
      ++reads === 1
        ? Promise.resolve({
            ...OPTIONS,
            current: {
              model: 'gpt-live',
              effort: 'high',
              defaulted: ['model'],
              acceptedInputSources: { effort: 'saved' }
            }
          })
        : deferred<AgentSessionOptionsResult>().promise,
    () => catalog.promise
  )
  const { mutate } = recordingMutate(async () => accepted({ key: 'effort', value: 'low' }, true))
  rememberMobileCreatedStructuredSession('answered-retention', 'worktree')
  const harness = await mountOptions({
    ...BASE,
    sessionId: 'answered-retention',
    client: client.client,
    mutate,
    sendSelection: true,
    coherentCatalog: true
  })
  expect(harness.current().sendSelection()).toEqual({ selection: { effort: 'high' } })
  await harness.rerender({ fence: 2 })
  expect(harness.current().sendSelection()).toEqual({ selection: { effort: 'high' } })
  await act(async () =>
    catalog.resolve({
      origin: 'probe',
      fetchedAt: 1,
      models: OPTIONS.models,
      listingNamesConfiguredModel: true
    })
  )
  await settle()
  expect(harness.current().sendSelection()).toEqual({ selection: { effort: 'high' } })
  await harness.unmount()
})

it('phone captures accepted echoed inputs, preserves false, and freezes empty vs legacy presence', async () => {
  let answer: AgentSessionOptionsResult = {
    ...FAST_OPTIONS,
    models: [
      {
        id: 'opus',
        label: 'Opus',
        isDefault: true,
        supportsFastMode: true,
        efforts: [{ value: 'high', label: 'High' }]
      }
    ],
    current: {
      model: 'opus',
      effort: 'high',
      fastMode: false,
      confirmed: ['fastMode'],
      acceptedInputSources: {}
    }
  }
  const client = optionsClient(async () => answer)
  const { mutate } = recordingMutate(async () => accepted({ key: 'model', value: 'opus' }, true))
  const harness = await mountOptions({
    ...BASE,
    agent: 'claude',
    client: client.client,
    mutate,
    sendSelection: true
  })
  expect(harness.current().sendSelection()).toEqual({ selection: {} })
  answer = {
    ...answer,
    current: { ...answer.current, acceptedInputSources: { model: 'saved', fastMode: 'policy' } }
  }
  await harness.rerender({ optionStamp: 'saved-origin' })
  await settle()
  const captured = harness.current().sendSelection()
  expect(captured).toEqual({ selection: { model: 'opus', fastMode: 'false' } })
  answer = {
    ...answer,
    current: { ...answer.current, effort: 'high', acceptedInputSources: { effort: 'saved' } }
  }
  await harness.rerender({ optionStamp: 'other-client' })
  await settle()
  expect(harness.current().sendSelection()).toEqual({ selection: { effort: 'high' } })
  expect(captured).toEqual({ selection: { model: 'opus', fastMode: 'false' } })
  await harness.unmount()
})

it('accepts a typed literal at an attached fence while options refresh with no menu', async () => {
  const pending = deferred<AgentSessionOptionsResult>()
  let reads = 0
  const client = optionsClient(() =>
    ++reads === 1 ? Promise.resolve({ models: [], current: {} }) : pending.promise
  )
  const { calls, mutate } = recordingMutate(async () =>
    accepted({ key: 'model', value: 'literal', options: { model: 'literal' } }, true)
  )
  const view = await mountOptions({ ...BASE, client: client.client, mutate })
  await view.rerender({ fence: 2 })
  let result = true
  await act(async () => {
    result = await view.current().setStructuredOption('model', 'literal')
  })
  expect(result).toBe(true)
  expect(calls).toHaveLength(1)
  await act(async () => pending.resolve({ models: [], current: {} }))
  await settle()
  await act(async () => {
    result = await view.current().setStructuredOption('model', 'literal')
  })
  expect(result).toBe(true)
  expect(calls).toHaveLength(2)
  await view.unmount()
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
