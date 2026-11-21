import { randomUUID } from 'node:crypto'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionOptionSelectChoice } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { stubRpcClient } from '../../../../transport/rpc/rpc-client-test-stub'
import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'

const BASE = 'claude-sonnet-5-5'
const PROVIDER_A = 'provider-a/claude-sonnet-5-5'
const PROVIDER_B = 'provider-b/claude-sonnet-5-5'

const discoveredModels = [
  {
    id: BASE,
    label: 'Sonnet 5.5',
    description: 'Fast for routine tasks',
    resolvedModel: BASE
  },
  {
    id: PROVIDER_A,
    label: 'Sonnet 5.5',
    description: 'Fast for routine tasks',
    resolvedModel: BASE
  },
  {
    id: PROVIDER_B,
    label: 'Sonnet 5.5',
    description: 'Fast for routine tasks',
    resolvedModel: BASE
  }
]

describe('terminal Claude model picker on the phone', () => {
  let renderer: ReactTestRenderer | null = null
  let view: ReturnType<typeof useMobileNativeChatSessionOptionController> | null = null
  const dispatchCommand = vi.fn(async () => 'accepted' as const)
  const sent: { method: string; params: unknown }[] = []
  let hostId = ''
  const client = stubRpcClient({
    sendRequest: (method, params) => {
      sent.push({ method, params })
      return Promise.resolve({
        id: method,
        ok: true as const,
        result: {
          success: true,
          catalogOrigin: 'probe',
          models: discoveredModels
        }
      })
    }
  })

  function Probe(props: {
    structured: boolean
    reportedModel?: string | null
    client?: RpcClient
    chatView?: boolean
  }): null {
    view = useMobileNativeChatSessionOptionController({
      client: props.client ?? client,
      activeChatStructured: props.structured,
      activeSessionTabId: 'tab',
      agent: 'claude',
      dispatchCommand,
      hostId,
      isTabChatView: () => props.chatView !== false,
      isWorking: false,
      reportedModel: props.reportedModel ?? null,
      structured: {
        snapshot: [],
        pendingId: null,
        setOption: async () => false,
        invokeAction: async () => false
      },
      toggleTabChatView: () => {},
      worktreeId: 'worktree'
    })
    return null
  }

  const mount = (structured = false, reportedModel: string | null = null): void => {
    act(() => {
      renderer = create(createElement(Probe, { structured, reportedModel }))
    })
  }

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const currentModel = (): string | null => {
    const model = view?.nativeChatSessionOptions?.controller.snapshot.find(
      (descriptor) => descriptor.id === 'model'
    )
    return model?.kind.type === 'select' ? (model.kind.currentValue ?? null) : null
  }

  const modelChoices = (): SessionOptionSelectChoice[] => {
    const model = view?.nativeChatSessionOptions?.controller.snapshot.find(
      (descriptor) => descriptor.id === 'model'
    )
    return model?.kind.type === 'select' ? [...model.kind.choices] : []
  }

  beforeEach(() => {
    hostId = `host-${randomUUID()}`
    dispatchCommand.mockClear()
    sent.length = 0
  })

  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
    view = null
  })

  it('shows host custom routes distinctly and switches with the full model id', async () => {
    mount()
    await flush()

    const choices = modelChoices()
    const primary = choices.filter((choice) => !choice.legacy)
    expect(primary.map((choice) => choice.value)).toEqual(
      expect.arrayContaining([PROVIDER_A, PROVIDER_B])
    )
    expect(choices.find((choice) => choice.value === PROVIDER_A)).toMatchObject({
      value: PROVIDER_A,
      label: 'Sonnet 5.5 (provider-a)'
    })
    expect(choices.find((choice) => choice.value === PROVIDER_B)).toMatchObject({
      value: PROVIDER_B,
      label: 'Sonnet 5.5 (provider-b)'
    })
    expect(sent.some((call) => call.method === 'git.discoverCommitMessageModels')).toBe(true)

    const controller = view?.nativeChatSessionOptions?.controller
    if (!controller) {
      throw new Error('missing model picker')
    }
    await act(async () => {
      await controller.setOption('model', PROVIDER_A)
    })
    expect(dispatchCommand).toHaveBeenCalledWith(`/model ${PROVIDER_A}`)
    expect(sent).toContainEqual({
      method: 'git.discoverCommitMessageModels',
      params: { worktree: 'id:worktree', agentId: 'claude' }
    })
  })

  it('keeps the selected provider route when a status report names the shared base id', async () => {
    mount()
    await flush()
    const controller = view?.nativeChatSessionOptions?.controller
    if (!controller) {
      throw new Error('missing model picker')
    }
    await act(async () => {
      await controller.setOption('model', PROVIDER_B)
    })
    act(() => {
      renderer?.update(createElement(Probe, { structured: false, reportedModel: BASE }))
    })
    await flush()
    expect(currentModel()).toBe(PROVIDER_B)
  })

  it('asks the host again across Chat, Terminal, and Chat', async () => {
    mount()
    await flush()
    expect(sent.filter((call) => call.method === 'git.discoverCommitMessageModels')).toHaveLength(1)
    act(() => {
      renderer?.update(createElement(Probe, { structured: false, chatView: false }))
    })
    await flush()
    act(() => {
      renderer?.update(createElement(Probe, { structured: false, chatView: true }))
    })
    await flush()
    expect(sent.filter((call) => call.method === 'git.discoverCommitMessageModels')).toHaveLength(2)
  })

  it('asks the host again when chat is closed and reopened', async () => {
    mount()
    await flush()
    expect(sent.filter((call) => call.method === 'git.discoverCommitMessageModels')).toHaveLength(1)
    act(() => {
      renderer?.unmount()
    })
    renderer = null
    view = null
    mount()
    await flush()
    // The phone does not keep its own 10 minute list. The host cache answers this second ask
    // without starting another probe, and drops that answer when agents refresh.
    expect(sent.filter((call) => call.method === 'git.discoverCommitMessageModels')).toHaveLength(2)
  })

  it('drops a stale catalog when chat returns and the refresh probe fails', async () => {
    let calls = 0
    const flaky = stubRpcClient({
      sendRequest: () => {
        calls += 1
        if (calls > 1) {
          return Promise.resolve({
            id: 'git.discoverCommitMessageModels',
            ok: true as const,
            result: { success: false }
          })
        }
        return Promise.resolve({
          id: 'git.discoverCommitMessageModels',
          ok: true as const,
          result: {
            success: true,
            catalogOrigin: 'probe' as const,
            models: discoveredModels
          }
        })
      }
    })
    act(() => {
      renderer = create(createElement(Probe, { structured: false, client: flaky }))
    })
    await flush()
    expect(modelChoices().map((choice) => choice.value)).toEqual(
      expect.arrayContaining([PROVIDER_A, PROVIDER_B])
    )

    act(() => {
      renderer?.update(createElement(Probe, { structured: true, client: flaky }))
    })
    await flush()
    act(() => {
      renderer?.update(createElement(Probe, { structured: false, client: flaky }))
    })
    await flush()
    await flush()
    const values = modelChoices().map((choice) => choice.value)
    expect(values).not.toContain(PROVIDER_A)
    expect(values).not.toContain(PROVIDER_B)
    expect(calls).toBe(2)
  })

  it('leaves structured Claude chat on its own model list', async () => {
    mount(true)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sent.some((call) => call.method === 'git.discoverCommitMessageModels')).toBe(false)
  })
})
