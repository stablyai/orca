import { randomUUID } from 'node:crypto'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileNativeChatSendOutcome } from '../composer/mobile-native-chat-send'

import {
  useMobileNativeChatSessionOptions,
  type MobileNativeChatSessionOptionsController
} from './use-mobile-native-chat-session-options'

type HookArgs = Parameters<typeof useMobileNativeChatSessionOptions>[0]

describe('useMobileNativeChatSessionOptions', () => {
  let renderer: ReactTestRenderer | null = null
  let api: MobileNativeChatSessionOptionsController | null = null
  let hookArgs: HookArgs
  let hostId: string
  const scopeKey = (tabId: string): string => `${hostId}\0worktree\0${tabId}`
  const dispatchCommand = vi.fn<HookArgs['dispatchCommand']>()
  const onAgentPicker = vi.fn()

  function Probe(): null {
    api = useMobileNativeChatSessionOptions(hookArgs)
    return null
  }

  const mount = (overrides: Partial<HookArgs> = {}): void => {
    hookArgs = {
      agent: 'claude',
      scopeKey: scopeKey('tab'),
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
    hostId = `mobile-session-options-test-${randomUUID()}`
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
    update({ scopeKey: scopeKey('other-tab') })
    update({ scopeKey: scopeKey('tab') })
    await act(async () => {
      resolveModel('accepted')
      await picked
    })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'opus' })
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
    update({ scopeKey: scopeKey('other') })
    update({ scopeKey: scopeKey('tab') })
    expect(api!.snapshot[0]).toMatchObject({ valueSource: 'dispatched' })
    expect(api!.snapshot[0]!.kind).toMatchObject({ currentValue: 'opus' })
  })

  it('keeps the live tab’s tracked model when other tabs overflow the record cap', async () => {
    mount()
    await act(async () => {
      await api!.setOption('model', 'opus')
    })
    // Repeatedly touch the live tab while exceeding capacity so insertion-order eviction would lose it.
    for (let index = 0; index < 40; index += 1) {
      update({ scopeKey: scopeKey(`overflow-${index}`) })
      update({ scopeKey: scopeKey('tab') })
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
    update({ scopeKey: scopeKey('other-tab') })
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
