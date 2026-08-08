import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
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
  const dispatchCommand = vi.fn<(command: string) => Promise<MobileNativeChatSendOutcome>>()
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
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
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

  it('serves the shared catalog snapshot for the agent', () => {
    mount()
    expect(api!.snapshot[0]).toMatchObject({ id: 'model', category: 'model' })
    expect(api!.snapshot[0]!.kind).toMatchObject({ type: 'select' })
  })

  it('returns an empty snapshot for agents without a catalog', () => {
    mount({ agent: 'amp' })
    expect(api!.snapshot).toEqual([])
  })

  it('does not expose catalog-backed agents outside the Claude and Codex scope', () => {
    mount({ agent: 'gemini' })
    expect(api!.snapshot).toEqual([])
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

  it('keeps tracked truth when the dispatch is rejected', async () => {
    dispatchCommand.mockResolvedValue('rejected')
    mount()
    let applied: boolean | undefined
    await act(async () => {
      applied = await api!.setOption('model', 'opus')
    })
    expect(applied).toBe(false)
    expect(api!.snapshot[0]).toMatchObject({ valueSource: 'unknown' })
  })

  it('applies Codex model changes through the native command', async () => {
    mount({ agent: 'codex' })
    expect(api!.snapshot[0]?.action).toBeUndefined()
    await act(async () => {
      await api!.setOption('model', 'gpt-5.5')
    })
    expect(dispatchCommand).toHaveBeenCalledWith('/model gpt-5.5')
    expect(onAgentPicker).not.toHaveBeenCalled()
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
    // A report lands while `/effort low` is still in flight and moves the model.
    update({ reportedModel: 'claude-opus-5' })
    await act(async () => {
      resolvers[0]!('accepted')
      await applied
    })
    // The effort must not be recorded against Opus — it was sent for Sonnet.
    const effort = api!.snapshot.find((descriptor) => descriptor.id === 'effort')
    expect(effort?.kind).not.toMatchObject({ currentValue: 'low' })
  })

  it('does not revive a stale session-start report over a newer local pick', async () => {
    mount({ reportedModel: 'claude-sonnet-5' })
    await act(async () => {
      await api!.setOption('model', 'opus')
    })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'opus' })
    // Leaving the tab and returning re-delivers the SAME session-start report,
    // which cannot have observed the `/model opus` sent after it.
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
    // Far more scopes than the cap, revisiting the live tab in between the way a
    // chat↔terminal flip does — insertion-order eviction would shed it.
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
