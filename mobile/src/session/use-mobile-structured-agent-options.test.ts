import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

const OPTIONS: AgentSessionOptionsResult = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'gpt-fast',
      label: 'GPT Fast',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }
      ]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

/** Session support and the provider catalog both say yes, which is the only shape
 *  that earns a Fast row. */
const FAST_OPTIONS: AgentSessionOptionsResult = {
  ...OPTIONS,
  models: OPTIONS.models.map((model) => ({ ...model, supportsFastMode: true })),
  fastModeSupport: { supported: true },
  current: { ...OPTIONS.current, fastMode: false, confirmed: ['fastMode'] }
}

const FAST_OPTIONS_ON: AgentSessionOptionsResult = {
  ...FAST_OPTIONS,
  current: { ...FAST_OPTIONS.current, fastMode: true }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function rpcSuccess(result: unknown) {
  return { id: 'rpc-1', ok: true as const, result, _meta: { runtimeId: 'runtime-1' } }
}

type SentRequest = { method: string; params: unknown }

/** `reads` yields what each successive `agentSession.options` call resolves to, so a test can
 *  make the post-write refresh disagree with the first read. */
function optionsClient(reads: () => Promise<AgentSessionOptionsResult>) {
  const sent: SentRequest[] = []
  const client: RpcClient = {
    sendRequest: async (method: string, params?: unknown) => {
      sent.push({ method, params })
      return rpcSuccess(method === 'agentSession.options' ? await reads() : {})
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const methods = (name: string) => sent.filter((entry) => entry.method === name)
  return { client, sent, methods, optionReads: () => methods('agentSession.options').length }
}

/** Resolves the queue in order and repeats the last entry, so a refresh read that a test did not
 *  script still answers instead of hanging. */
function queuedReads(...results: AgentSessionOptionsResult[]) {
  let index = 0
  return () => Promise.resolve(results[Math.min(index++, results.length - 1)]!)
}

type MutateCall = { method: string; fields: Record<string, unknown> }

/** `next` answers the nth write. An untyped `vi.fn` is what satisfies the generic mutate
 *  signature: a concrete fixture cannot produce the caller's `TValue` on its own. */
function recordingMutate(
  next: (call: number) => Promise<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>
) {
  const calls: MutateCall[] = []
  const mock = vi.fn()
  mock.mockImplementation(
    (method: string, _fingerprintMethod: string, fields: Record<string, unknown>) => {
      calls.push({ method, fields })
      return next(calls.length - 1)
    }
  )
  const mutate: StructuredAgentSessionMutate = mock
  return { calls, mutate }
}

function accepted(
  value: AgentSessionOptionResult,
  sameFence: boolean
): StructuredAgentSessionMutationResult<AgentSessionOptionResult> {
  return { status: 'accepted', value, sameFence }
}

type Controller = ReturnType<typeof useMobileStructuredAgentOptions>

type ProbeProps = {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  fence: number | null
  optionsRevision?: number
  mutate: StructuredAgentSessionMutate
  onRender: (controller: Controller) => void
}

function Probe(props: ProbeProps): null {
  props.onRender(
    useMobileStructuredAgentOptions({
      agent: props.agent,
      client: props.client,
      sessionId: props.sessionId,
      enabled: true,
      fence: props.fence,
      optionsRevision: props.optionsRevision ?? 0,
      mutate: props.mutate
    })
  )
  return null
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountOptions(props: Omit<ProbeProps, 'onRender'>) {
  let rendered: Controller | null = null
  const onRender = (controller: Controller) => {
    rendered = controller
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(Probe, { ...props, onRender }))
  })
  await settle()
  const current = (): Controller => {
    if (!rendered) {
      throw new Error('probe never rendered')
    }
    return rendered
  }
  return {
    current,
    rerender: async (next: Partial<Omit<ProbeProps, 'onRender'>>) => {
      await act(async () => {
        renderer?.update(createElement(Probe, { ...props, ...next, onRender }))
      })
      await settle()
    },
    unmount: async () => {
      await act(async () => renderer?.unmount())
    }
  }
}

function descriptorFor(
  snapshot: readonly SessionOptionDescriptor[],
  id: string
): SessionOptionDescriptor | undefined {
  return snapshot.find((entry) => entry.id === id)
}

function currentValueOf(snapshot: readonly SessionOptionDescriptor[], id: string) {
  const kind = descriptorFor(snapshot, id)?.kind
  return kind && 'currentValue' in kind ? kind.currentValue : undefined
}

const BASE = { agent: 'codex', sessionId: 'session-1', fence: 1 } as const

describe('useMobileStructuredAgentOptions fast mode', () => {
  it('round-trips a boolean fastMode pick as the wire string and remembers the decoded pick', async () => {
    const client = optionsClient(queuedReads(FAST_OPTIONS, FAST_OPTIONS_ON))
    const { calls, mutate } = recordingMutate(async () =>
      accepted(
        { key: 'fastMode', value: 'true', options: { model: 'gpt-live', fastMode: 'true' } },
        true
      )
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(false)

    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('fastMode', true)
    })
    await settle()

    expect(outcome).toBe(true)
    // The crux of the provider-aware fast mode change: a boolean reaches the wire encoded.
    expect(calls).toEqual([
      { method: 'agentSession.setOption', fields: { key: 'fastMode', value: 'true' } }
    ])
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(true)

    const persisted = client.methods('settings.mutateNativeChatSessionOptions')
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.params).toMatchObject({
      type: 'apply-picks',
      agent: 'codex',
      // Decoded back to a boolean: the pick a later launch seeds from must not be the string.
      picks: expect.arrayContaining([{ modelId: 'gpt-live', optionId: 'fastMode', value: true }])
    })
    await harness.unmount()
  })

  it('offers no Fast row when the provider catalog never claimed support', async () => {
    const client = optionsClient(queuedReads(OPTIONS))
    const { calls, mutate } = recordingMutate(async () =>
      accepted({ key: 'fastMode', value: 'true' }, true)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(descriptorFor(harness.current().optionSnapshot, 'model')).toBeDefined()
    expect(descriptorFor(harness.current().optionSnapshot, 'fastMode')).toBeUndefined()

    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('fastMode', true)
    })
    expect(outcome).toBe(false)
    expect(calls).toEqual([])
    await harness.unmount()
  })

  it('offers no Fast row when the session reports fast mode unsupported', async () => {
    const client = optionsClient(
      queuedReads({ ...FAST_OPTIONS, fastModeSupport: { supported: false, reason: 'account' } })
    )
    const { mutate } = recordingMutate(async () => ({ status: 'rejected' }))
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(descriptorFor(harness.current().optionSnapshot, 'fastMode')).toBeUndefined()
    await harness.unmount()
  })

  it('offers no Fast row when the model capability is unknown', async () => {
    const client = optionsClient(
      queuedReads({
        ...FAST_OPTIONS,
        // Absent `supportsFastMode` means the host could not determine support, never "yes".
        models: OPTIONS.models
      })
    )
    const { mutate } = recordingMutate(async () => ({ status: 'rejected' }))
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(descriptorFor(harness.current().optionSnapshot, 'fastMode')).toBeUndefined()
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions post-write refresh', () => {
  it('reads options back after an accepted same-fence write and applies the refreshed value', async () => {
    const client = optionsClient(queuedReads(FAST_OPTIONS, FAST_OPTIONS_ON))
    // `options: {}` commits nothing optimistically, so only the refresh can move the value.
    const { mutate } = recordingMutate(async () =>
      accepted({ key: 'fastMode', value: 'true', options: {} }, true)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    expect(client.optionReads()).toBe(1)
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(false)

    await act(async () => {
      await harness.current().setStructuredOption('fastMode', true)
    })
    await settle()

    expect(client.optionReads()).toBe(2)
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(true)
    await harness.unmount()
  })

  it('skips the refresh when the write landed against a different fence', async () => {
    const client = optionsClient(queuedReads(FAST_OPTIONS, FAST_OPTIONS_ON))
    const { mutate } = recordingMutate(async () =>
      accepted({ key: 'fastMode', value: 'true', options: {} }, false)
    )
    const harness = await mountOptions({ ...BASE, client: client.client, mutate })

    await act(async () => {
      await harness.current().setStructuredOption('fastMode', true)
    })
    await settle()

    expect(client.optionReads()).toBe(1)
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(false)
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions provider refresh', () => {
  it('applies a provider-owned plan-mode exit when its options revision advances', async () => {
    const plan: AgentSessionOptionsResult = {
      ...OPTIONS,
      permissionModeRestoreValue: 'acceptEdits',
      current: { ...OPTIONS.current, permissionMode: 'plan', confirmed: ['permissionMode'] }
    }
    const restored: AgentSessionOptionsResult = {
      ...plan,
      current: { ...OPTIONS.current, permissionMode: 'acceptEdits', confirmed: ['permissionMode'] }
    }
    const client = optionsClient(queuedReads(plan, restored))
    const { mutate } = recordingMutate(async () => ({ status: 'rejected' }))
    const harness = await mountOptions({
      ...BASE,
      agent: 'claude',
      client: client.client,
      mutate
    })

    expect(currentValueOf(harness.current().optionSnapshot, 'permissionMode')).toBe('plan')

    await harness.rerender({ optionsRevision: 1 })

    expect(client.optionReads()).toBe(2)
    expect(currentValueOf(harness.current().optionSnapshot, 'permissionMode')).toBe('acceptEdits')
    await harness.unmount()
  })

  it('does not let an older post-write read overwrite the provider refresh', async () => {
    const postWrite = deferred<AgentSessionOptionsResult>()
    const providerRefresh = deferred<AgentSessionOptionsResult>()
    let read = 0
    const client = optionsClient(() => {
      read += 1
      if (read === 1) {
        return Promise.resolve(FAST_OPTIONS)
      }
      return read === 2 ? postWrite.promise : providerRefresh.promise
    })
    const { mutate } = recordingMutate(async () =>
      accepted({ key: 'fastMode', value: 'true', options: {} }, true)
    )
    const harness = await mountOptions({
      ...BASE,
      client: client.client,
      mutate
    })

    await act(async () => {
      await harness.current().setStructuredOption('fastMode', true)
    })
    await harness.rerender({ optionsRevision: 1 })
    expect(client.optionReads()).toBe(3)

    await act(async () => providerRefresh.resolve(FAST_OPTIONS_ON))
    await settle()
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(true)

    await act(async () => postWrite.resolve(FAST_OPTIONS))
    await settle()
    expect(currentValueOf(harness.current().optionSnapshot, 'fastMode')).toBe(true)
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions generation fencing', () => {
  it('drops an options read a later write superseded', async () => {
    const stale = deferred<AgentSessionOptionsResult>()
    const first = optionsClient(queuedReads(FAST_OPTIONS))
    // A reconnect hands the hook a new client, so only the read effect re-runs: the record
    // survives and the in-flight read is not marked stale. Generation is the only guard left.
    const reconnected = optionsClient(() => stale.promise)
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({ ...BASE, client: first.client, mutate })

    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-live')
    await harness.rerender({ client: reconnected.client })
    expect(reconnected.optionReads()).toBe(1)

    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('model', 'gpt-fast')
    })
    await settle()
    expect(outcome).toBe(true)
    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-fast')

    await act(async () => {
      stale.resolve({ ...FAST_OPTIONS, conversationCommands: ['compact'] })
    })
    await settle()

    expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-fast')
    expect(harness.current().conversationCommands).toEqual([])
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions pending guard', () => {
  it('refuses an overlapping write and releases the guard once the first one settles', async () => {
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

    let overlapping: boolean | null = null
    await act(async () => {
      overlapping = await harness.current().setStructuredOption('fastMode', true)
    })
    expect(overlapping).toBe(false)
    expect(calls).toHaveLength(1)

    await act(async () => {
      inFlight.resolve(accepted({ key: 'effort', value: 'high' }, false))
      await firstWrite
    })
    await settle()
    expect(await firstWrite).toBe(true)
    expect(harness.current().pendingOptionId).toBeNull()

    // The guard is a ref, so a write that never clears it wedges every later pick.
    let later: boolean | null = null
    await act(async () => {
      later = await harness.current().setStructuredOption('fastMode', true)
    })
    await settle()
    expect(later).toBe(true)
    expect(calls).toHaveLength(2)
    await harness.unmount()
  })
})
