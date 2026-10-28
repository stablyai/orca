import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileNativeChatSendOutcome } from '../mobile-native-chat-send'
import {
  clearMobileSessionOptionRecordsForTests,
  useMobileNativeChatSessionOptions,
  type MobileNativeChatSessionOptionsController
} from './use-mobile-native-chat-session-options'

type HookArgs = Parameters<typeof useMobileNativeChatSessionOptions>[0]

describe('useMobileNativeChatSessionOptions', () => {
  let renderer: ReactTestRenderer | null = null
  let api: MobileNativeChatSessionOptionsController | null = null
  let hookArgs: HookArgs
  const dispatchCommand = vi.fn<HookArgs['dispatchCommand']>()
  const onAgentPicker = vi.fn()

  function Probe(): null {
    api = useMobileNativeChatSessionOptions(hookArgs)
    return null
  }

  const mount = (overrides: Partial<HookArgs> = {}): void => {
    hookArgs = {
      agent: 'claude',
      scopeKey: 'host\0worktree\0tab',
      reportedModel: null,
      dispatchCommand,
      onAgentPicker,
      ...overrides
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
  }

  const update = (overrides: Partial<HookArgs>): void => {
    hookArgs = { ...hookArgs, ...overrides }
    act(() => {
      renderer!.update(createElement(Probe))
    })
  }

  beforeEach(() => {
    clearMobileSessionOptionRecordsForTests()
    dispatchCommand.mockReset()
    dispatchCommand.mockResolvedValue('accepted')
    onAgentPicker.mockReset()
  })
  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
    api = null
  })

  it('shows an OMP session under the model its hook reported', () => {
    mount({ agent: 'omp' })
    expect(api!.snapshot).toEqual([])
    update({ reportedModel: 'deepseek/deepseek-v4-pro' })
    const model = api!.snapshot[0]!
    expect(model).toMatchObject({ id: 'model', category: 'model', valueSource: 'reported' })
    expect(model.kind).toMatchObject({
      type: 'select',
      currentValue: 'deepseek/deepseek-v4-pro',
      choices: [{ value: 'deepseek/deepseek-v4-pro', label: 'deepseek/deepseek-v4-pro' }]
    })
  })

  it.each(['custom/current', 'deepseek/deepseek-v4-pro-new'])(
    'keeps the exact OMP report %s with discovered choices',
    (reportedModel) => {
      mount({
        agent: 'omp',
        reportedModel,
        discoveredModels: [{ id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek', options: [] }]
      })
      expect(api!.snapshot[0]).toMatchObject({ valueSource: 'reported' })
      expect(api!.snapshot[0]!.kind).toMatchObject({
        currentValue: reportedModel,
        choices: expect.arrayContaining([expect.objectContaining({ value: reportedModel })])
      })
    }
  )

  it('switches an OMP session with /orca-model <selector>', async () => {
    mount({
      agent: 'omp',
      reportedModel: 'deepseek/deepseek-v4-pro',
      modelSwitchCommand: 'orca-model'
    })
    let applied: boolean | undefined
    await act(async () => {
      applied = await api!.setOption('model', 'minimax-cn/MiniMax-M3')
    })
    expect(applied).toBe(true)
    expect(dispatchCommand).toHaveBeenCalledWith('/orca-model minimax-cn/MiniMax-M3')
    const model = api!.snapshot[0]!
    expect(model).toMatchObject({ valueSource: 'dispatched' })
    expect(model.kind).toMatchObject({ currentValue: 'minimax-cn/MiniMax-M3' })
    update({ reportedModel: 'minimax-cn/MiniMax-M3' })
    expect(api!.snapshot[0]).toMatchObject({ valueSource: 'reported' })
  })

  it('applies a model pick through the catalog modelApply command', async () => {
    mount()
    let applied: boolean | undefined
    await act(async () => {
      applied = await api!.setOption('model', 'opus')
    })
    expect(applied).toBe(true)
    expect(dispatchCommand).toHaveBeenCalledWith('/model opus')
    const model = api!.snapshot[0]!
    expect(model).toMatchObject({ valueSource: 'dispatched' })
    expect(model.kind).toMatchObject({ currentValue: 'opus' })
  })

  it.each(['rejected', 'unknown'] as const)(
    'keeps tracked truth when the write is %s',
    async (outcome) => {
      dispatchCommand.mockResolvedValue(outcome)
      mount()
      let applied: boolean | undefined
      await act(async () => {
        applied = await api!.setOption('model', 'opus')
      })
      expect(applied).toBe(false)
      expect(api!.snapshot[0]).toMatchObject({ valueSource: 'unknown' })
    }
  )

  it('offers Grok pickers and saves a pick as the host launch default', async () => {
    const writeSettings = vi.fn()
    mount({ agent: 'grok', writeSettings })
    expect(api!.snapshot[0]).toMatchObject({ id: 'model', settable: true })
    const model = api!.snapshot[0]!.kind
    const target = model.type === 'select' ? model.choices[0]!.value : ''
    await act(async () => {
      expect(await api!.setOption('model', target)).toBe(true)
    })
    expect(writeSettings).toHaveBeenCalledWith({
      type: 'apply-picks',
      agent: 'grok',
      picks: [expect.objectContaining({ modelId: target, optionId: 'model', value: target })]
    })
  })

  it('saves a Claude effort but never its unconfirmed model switch as a launch default', async () => {
    const writeSettings = vi.fn()
    mount({ reportedModel: 'claude-sonnet-5', writeSettings })
    await act(async () => {
      await api!.setOption('model', 'opus')
      await api!.setOption('effort', 'low')
    })
    expect(writeSettings).toHaveBeenCalledTimes(1)
    expect(writeSettings).toHaveBeenCalledWith({
      type: 'apply-picks',
      agent: 'claude',
      picks: [expect.objectContaining({ optionId: 'effort', adoptModelAsLaunchDefault: false })]
    })
  })

  it('starts over when the tab runs another agent and then a fresh session', async () => {
    mount({ reportedModel: 'claude-sonnet-5' })
    await act(async () => {
      await api!.setOption('model', 'opus')
    })
    update({ agent: 'codex', reportedModel: null })
    update({ agent: 'claude', reportedModel: 'claude-sonnet-5' })
    expect(api!.snapshot[0]).toMatchObject({ valueSource: 'reported' })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'sonnet' })
  })

  it('drops a write that lands after the tab started another agent', async () => {
    let resolveModel!: (outcome: MobileNativeChatSendOutcome) => void
    dispatchCommand.mockImplementationOnce(
      () =>
        new Promise<MobileNativeChatSendOutcome>((resolve) => {
          resolveModel = resolve
        })
    )
    mount({ reportedModel: 'claude-sonnet-5' })
    let picked!: Promise<boolean>
    await act(async () => {
      picked = api!.setOption('model', 'opus')
      await Promise.resolve()
    })
    update({ agent: 'codex', reportedModel: 'gpt-5.5' })
    await act(async () => {
      resolveModel('accepted')
      await expect(picked).resolves.toBe(false)
    })
    act(() => renderer!.unmount())
    mount({ agent: 'codex', reportedModel: 'gpt-5.5' })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'gpt-5.5' })
  })

  it('shows a pick that lands after the user left the chat and came back', async () => {
    let resolveModel!: (outcome: MobileNativeChatSendOutcome) => void
    dispatchCommand.mockImplementationOnce(
      () =>
        new Promise<MobileNativeChatSendOutcome>((resolve) => {
          resolveModel = resolve
        })
    )
    mount({ reportedModel: 'claude-sonnet-5' })
    let picked!: Promise<boolean>
    await act(async () => {
      picked = api!.setOption('model', 'opus')
      await Promise.resolve()
    })
    update({ scopeKey: 'host\0worktree\0other-tab' })
    update({ scopeKey: 'host\0worktree\0tab' })
    await act(async () => {
      resolveModel('accepted')
      await picked
    })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'opus' })
  })

  it('types the Codex picker command and switches to the terminal', async () => {
    mount({ agent: 'codex' })
    expect(api!.snapshot[0]?.action).toEqual({ type: 'agent-picker' })
    await act(async () => {
      await api!.invokeAction('model')
    })
    expect(dispatchCommand).toHaveBeenCalledWith('/model', { delivery: 'type' })
    expect(onAgentPicker).toHaveBeenCalledOnce()
  })

  it.each([null, 'gpt-5.6-terra'])(
    'tracks an unlisted Codex report after %s without inventing effort choices',
    async (initialModel) => {
      mount({ agent: 'codex', reportedModel: initialModel })
      update({ reportedModel: 'gpt-6.1-sol' })
      expect(api!.snapshot).toHaveLength(1)
      expect(api!.snapshot[0]).toMatchObject({
        valueSource: 'reported',
        action: { type: 'agent-picker' },
        kind: {
          currentValue: 'gpt-6.1-sol',
          choices: expect.arrayContaining([{ value: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }])
        }
      })
      const snapshot = api!.snapshot
      update({ reportedModel: null })
      update({ reportedModel: 'gpt-6.1-sol' })
      expect(api!.snapshot).toBe(snapshot)
      await act(async () => {
        await api!.invokeAction('model')
      })
      expect(dispatchCommand).toHaveBeenCalledWith('/model', { delivery: 'type' })
    }
  )

  it('types the Codex effort picker command', async () => {
    mount({ agent: 'codex', reportedModel: 'gpt-5.5' })
    await act(async () => {
      await api!.invokeAction('effort')
    })
    expect(dispatchCommand).toHaveBeenCalledWith('/model', { delivery: 'type' })
    expect(onAgentPicker).toHaveBeenCalledOnce()
  })

  it('seeds the current model from a hook-reported provider model', () => {
    mount({ reportedModel: 'claude-sonnet-5' })
    const model = api!.snapshot[0]!
    expect(model).toMatchObject({ valueSource: 'reported' })
    expect(model.kind).toMatchObject({ currentValue: 'sonnet' })
  })

  it('tracks typed commands via recordCommand', () => {
    mount()
    act(() => {
      api!.recordCommand('/model haiku')
    })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'haiku' })
    expect(api!.snapshot[0]).toMatchObject({ valueSource: 'dispatched' })
  })

  it('applies an option under the tracked model and scopes it to that model', async () => {
    mount({ reportedModel: 'claude-sonnet-5' })
    await act(async () => {
      await api!.setOption('effort', 'low')
    })
    expect(dispatchCommand).toHaveBeenCalledWith('/effort low')
    const effort = api!.snapshot.find((descriptor) => descriptor.id === 'effort')
    expect(effort).toMatchObject({ valueSource: 'dispatched' })
    expect(effort!.kind).toMatchObject({ currentValue: 'low' })
  })

  it('does not file an option under a model that changed mid-dispatch', async () => {
    const resolvers: ((outcome: MobileNativeChatSendOutcome) => void)[] = []
    dispatchCommand.mockImplementation(
      () => new Promise<MobileNativeChatSendOutcome>((resolve) => resolvers.push(resolve))
    )
    mount({ reportedModel: 'claude-sonnet-5' })
    let applied!: Promise<boolean>
    await act(async () => {
      applied = api!.setOption('effort', 'low')
      await Promise.resolve()
    })
    update({ reportedModel: 'claude-opus-5' })
    await act(async () => {
      resolvers[0]!('accepted')
      await applied
    })
    const effort = api!.snapshot.find((descriptor) => descriptor.id === 'effort')
    expect(effort?.kind).not.toMatchObject({ currentValue: 'low' })
  })

  it('does not revive a stale session-start report over a newer local pick', async () => {
    mount({ reportedModel: 'claude-sonnet-5' })
    await act(async () => {
      await api!.setOption('model', 'opus')
    })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'opus' })
    // Re-entering repeats session-start evidence that predates later user picks.
    update({ scopeKey: 'host\0worktree\0other' })
    update({ scopeKey: 'host\0worktree\0tab' })
    expect(api!.snapshot[0]).toMatchObject({ valueSource: 'dispatched' })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'opus' })
  })

  it('still lets a genuinely new report supersede a local pick', async () => {
    mount({ reportedModel: 'claude-sonnet-5' })
    await act(async () => {
      await api!.setOption('model', 'opus')
    })
    update({ reportedModel: 'claude-haiku-4-5' })
    expect(api!.snapshot[0]).toMatchObject({ valueSource: 'reported' })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'haiku' })
  })

  it('keeps the live tab’s tracked model when other tabs overflow the record cap', async () => {
    mount()
    await act(async () => {
      await api!.setOption('model', 'opus')
    })
    // Repeatedly touch the live tab while exceeding capacity so insertion-order eviction would lose it.
    for (let index = 0; index < 40; index += 1) {
      update({ scopeKey: `host\0worktree\0overflow-${index}` })
      update({ scopeKey: 'host\0worktree\0tab' })
    }
    expect(api!.snapshot[0]).toMatchObject({ valueSource: 'dispatched' })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'opus' })
  })

  it('keeps the latest queued operation pending until it settles', async () => {
    const resolvers: ((outcome: MobileNativeChatSendOutcome) => void)[] = []
    dispatchCommand.mockImplementation(
      () =>
        new Promise<MobileNativeChatSendOutcome>((resolve) => {
          resolvers.push(resolve)
        })
    )
    mount({ reportedModel: 'claude-sonnet-5' })
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    await act(async () => {
      first = api!.setOption('effort', 'low')
      second = api!.setOption('model', 'opus')
      await Promise.resolve()
    })
    expect(api!.pendingId).toBe('model')
    await act(async () => {
      resolvers[0]!('accepted')
      await Promise.resolve()
    })
    expect(dispatchCommand).toHaveBeenCalledTimes(2)
    expect(api!.pendingId).toBe('model')
    await act(async () => {
      resolvers[1]!('accepted')
      await Promise.all([first, second])
    })
    expect(api!.pendingId).toBeNull()
  })

  it('does not dispatch a queued option into a newly active tab', async () => {
    let resolveFirst!: (outcome: MobileNativeChatSendOutcome) => void
    dispatchCommand.mockImplementationOnce(
      () =>
        new Promise<MobileNativeChatSendOutcome>((resolve) => {
          resolveFirst = resolve
        })
    )
    mount({ reportedModel: 'claude-sonnet-5' })
    let first!: Promise<boolean>
    let queued!: Promise<boolean>
    await act(async () => {
      first = api!.setOption('effort', 'low')
      queued = api!.setOption('model', 'opus')
      await Promise.resolve()
    })
    update({ scopeKey: 'host\0worktree\0other-tab' })
    await act(async () => {
      resolveFirst('accepted')
      await first
    })
    await expect(queued).resolves.toBe(false)
    expect(dispatchCommand).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch queued work after unmount', async () => {
    let resolveFirst!: (outcome: MobileNativeChatSendOutcome) => void
    dispatchCommand.mockImplementationOnce(
      () =>
        new Promise<MobileNativeChatSendOutcome>((resolve) => {
          resolveFirst = resolve
        })
    )
    mount({ reportedModel: 'claude-sonnet-5' })
    let first!: Promise<boolean>
    let queued!: Promise<boolean>
    await act(async () => {
      first = api!.setOption('effort', 'low')
      queued = api!.setOption('model', 'opus')
      await Promise.resolve()
    })
    act(() => {
      renderer!.unmount()
    })
    renderer = null
    resolveFirst('accepted')
    await expect(first).resolves.toBe(true)
    await expect(queued).resolves.toBe(false)
    expect(dispatchCommand).toHaveBeenCalledTimes(1)
  })
})
