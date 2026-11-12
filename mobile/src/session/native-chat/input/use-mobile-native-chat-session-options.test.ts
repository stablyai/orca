import { createNativeChatSessionOptionOwner } from '../../../../../src/shared/native-chat/input/native-chat-session-option-owner'
import {
  acquireNativeChatSessionOptionLease,
  readNativeChatSessionOptionSeedBinding
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-cache'
import type { NativeChatSessionOptionBinding } from '../../../../../src/shared/native-chat/input/native-chat-session-option-binding'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileNativeChatSendOutcome } from '../mobile-native-chat-send'
import {
  applyNativeChatSessionOptionSettingsMutation,
  resolveNativeChatSessionOptionDefaults
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-defaults'
import { resolveAgentSessionOptionLaunch } from '../../../../../src/shared/agent-session/options/agent-session-option-launch'
import type {
  PersistedNativeChatSessionOptions,
  NativeChatSessionOptionSettingsMutation
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
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
  const liveBindings = new Map<string, NativeChatSessionOptionBinding>()
  let session = 0
  const dispatchCommand = vi.fn<HookArgs['dispatchCommand']>()
  const onAgentPicker = vi.fn()

  function Probe(): null {
    api = useMobileNativeChatSessionOptions(hookArgs)
    return null
  }

  function ownerFor(agent: string | null, scopeKey: string | null): HookArgs['owner'] {
    if (!agent || !scopeKey) {
      return undefined
    }
    let binding = liveBindings.get(scopeKey)
    if (!binding || binding.agent !== agent) {
      binding = {
        agent,
        terminalHandle: scopeKey,
        providerSession: { key: 'session_id', id: String(++session) }
      }
      liveBindings.set(scopeKey, binding)
    }
    return createNativeChatSessionOptionOwner(
      readNativeChatSessionOptionSeedBinding(scopeKey, binding),
      () => liveBindings.get(scopeKey) ?? null
    )
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
    hookArgs.owner ??= ownerFor(hookArgs.agent, hookArgs.scopeKey)
    act(() => {
      renderer = create(createElement(Probe))
    })
  }

  const update = (overrides: Partial<HookArgs>): void => {
    hookArgs = {
      ...hookArgs,
      ...overrides,
      owner:
        overrides.owner ??
        ownerFor(overrides.agent ?? hookArgs.agent, overrides.scopeKey ?? hookArgs.scopeKey)
    }
    act(() => {
      renderer!.update(createElement(Probe))
    })
  }

  beforeEach(() => {
    clearMobileSessionOptionRecordsForTests()
    liveBindings.clear()
    session = 0
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

  it.each([
    ['grok', true],
    ['grok', false],
    ['omp', true],
    ['omp', false]
  ] as const)(
    '%s discovery cached=%s writes only an explicit owning-host pick',
    async (agent, cached) => {
      let persisted: PersistedNativeChatSessionOptions = { [agent]: { model: 'retired' } }
      const writeOwner = vi.fn((mutation: NativeChatSessionOptionSettingsMutation) => {
        persisted = applyNativeChatSessionOptionSettingsMutation(persisted, mutation) ?? persisted
      })
      const writeOther = vi.fn()
      const model = agent === 'grok' ? 'grok-4.7' : 'deepseek/deepseek-v4-pro'
      const discoveredModels = [{ id: model, label: model, options: [] }]
      mount({
        agent,
        scopeKey: 'owner\0worktree\0tab',
        reportedModel: 'retired',
        modelSwitchCommand: 'orca-model',
        writeSettings: writeOwner,
        discoveredModels: cached ? discoveredModels : null
      })
      if (!cached) {
        update({ discoveredModels })
      }
      expect(writeOwner).not.toHaveBeenCalled()
      expect(
        resolveAgentSessionOptionLaunch(
          agent,
          resolveNativeChatSessionOptionDefaults(persisted, agent)
        ).args
      ).toContain('retired')
      await act(async () => {
        expect(await api!.setOption('model', model)).toBe(true)
      })
      expect(writeOwner).toHaveBeenCalledOnce()
      expect(
        resolveAgentSessionOptionLaunch(
          agent,
          resolveNativeChatSessionOptionDefaults(persisted, agent)
        ).args
      ).toContain(model)
      update({ scopeKey: 'other\0worktree\0tab', writeSettings: writeOther })
      expect(writeOwner).toHaveBeenCalledOnce()
      expect(writeOther).not.toHaveBeenCalled()
    }
  )

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

  it('returns the accepted original result without changing its successor', async () => {
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
      await expect(picked).resolves.toBe(true)
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

  it.each([
    ['grok', 'known'],
    ['codex', 'known'],
    ['codex', 'canonical'],
    ['codex', 'selected'],
    ['codex', 'entry']
  ] as const)(
    'isolates a same-agent %s successor from old pending UI and picker effects after %s identity',
    async (agent, identitySource) => {
      let accept!: (outcome: MobileNativeChatSendOutcome) => void
      dispatchCommand.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            accept = resolve
          })
      )
      const writeOriginal = vi.fn()
      const writeSuccessor = vi.fn()
      const initialModel = agent === 'grok' ? 'grok-4.7' : 'gpt-5.5'
      const successorModel = agent === 'grok' ? 'grok-4.7-fast' : 'gpt-5.5-mini'
      const discoveredModels =
        agent === 'grok'
          ? [initialModel, successorModel].map((id) => ({ id, label: id, options: [] }))
          : undefined
      const scope = 'host\0worktree\0tab'
      const identityA = {
        agent,
        terminalHandle: scope,
        providerSession: { key: 'session_id' as const, id: 'A' }
      }
      liveBindings.set(
        scope,
        identitySource === 'selected' || identitySource === 'entry'
          ? { ...identityA, providerSession: undefined }
          : identityA
      )
      const owner =
        identitySource === 'known'
          ? undefined
          : createNativeChatSessionOptionOwner(
              { agent, terminalHandle: scope },
              () => liveBindings.get(scope) ?? null
            )
      mount({
        agent,
        owner,
        reportedModel: initialModel,
        writeSettings: writeOriginal,
        discoveredModels
      })
      let accepted!: Promise<boolean>
      await act(async () => {
        accepted =
          agent === 'codex' ? api!.invokeAction('model') : api!.setOption('model', 'grok-4.7-fast')
        await Promise.resolve()
      })
      expect(api!.pendingId).toBe('model')
      if (identitySource === 'entry') {
        act(() => {
          acquireNativeChatSessionOptionLease(
            scope,
            createNativeChatSessionOptionOwner(identityA, () => identityA)
          )?.release()
        })
        expect(api!.pendingId).toBe('model')
      }
      if (identitySource === 'selected') {
        liveBindings.set(scope, identityA)
        update({ reportedModel: initialModel })
        expect(api!.pendingId).toBe('model')
        liveBindings.set(scope, { ...identityA, providerSession: undefined })
        update({ reportedModel: initialModel })
        expect(api!.pendingId).toBe('model')
      }
      liveBindings.set(scope, {
        ...liveBindings.get(scope)!,
        providerSession: { key: 'session_id', id: 'successor' }
      })
      update({ reportedModel: successorModel, writeSettings: writeSuccessor })
      expect(api!.pendingId).toBeNull()
      await act(async () => {
        accept('accepted')
        expect(await accepted).toBe(true)
      })
      expect(api!.snapshot[0].kind).toMatchObject({ currentValue: successorModel })
      expect(onAgentPicker).not.toHaveBeenCalled()
      expect(writeSuccessor).not.toHaveBeenCalled()
      if (agent === 'grok') {
        expect(writeOriginal).toHaveBeenCalledOnce()
      } else {
        await act(async () => {
          expect(await api!.invokeAction('model')).toBe(true)
        })
        expect(onAgentPicker).toHaveBeenCalledOnce()
      }
    }
  )

  it('routes a blocked action error only to its original active provider session', async () => {
    const scope = 'host\0worktree\0tab'
    const original = {
      agent: 'codex',
      terminalHandle: scope,
      providerSession: { key: 'session_id' as const, id: 'A' }
    }
    liveBindings.set(scope, original)
    const onControlError = vi.fn()
    let reply!: (value: Awaited<ReturnType<HookArgs['dispatchCommand']>>) => void
    dispatchCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    const owner = createNativeChatSessionOptionOwner(
      { agent: 'codex', terminalHandle: scope },
      () => liveBindings.get(scope) ?? null
    )
    mount({ agent: 'codex', owner, onControlError })
    let first!: Promise<boolean>
    await act(async () => {
      first = api!.invokeAction('model')
      await Promise.resolve()
    })
    await act(async () => {
      reply({ outcome: 'blocked', reason: 'foreign-draft', agent: 'codex' })
      expect(await first).toBe(false)
    })
    expect(onControlError).toHaveBeenCalledOnce()
    onControlError.mockClear()
    let second!: Promise<boolean>
    await act(async () => {
      second = api!.invokeAction('model')
      await Promise.resolve()
    })
    liveBindings.set(scope, { ...original, providerSession: { key: 'session_id', id: 'B' } })
    update({})
    expect(api!.pendingId).toBeNull()
    liveBindings.set(scope, { agent: 'codex', terminalHandle: scope })
    await act(async () => {
      reply({ outcome: 'blocked', reason: 'foreign-draft', agent: 'codex' })
      expect(await second).toBe(false)
    })
    expect(onControlError).not.toHaveBeenCalled()
    expect(api!.pendingId).toBeNull()
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

  it('retains known report identity without replaying an unchanged model', async () => {
    const scope = 'host\0worktree\0tab'
    const unknown = { agent: 'claude', terminalHandle: scope }
    liveBindings.set(scope, unknown)
    mount({ reportedModel: 'claude-sonnet-5' })
    await act(async () => {
      await api!.setOption('model', 'opus')
    })
    act(() => {
      const known = { ...unknown, providerSession: { key: 'session_id' as const, id: 'A' } }
      acquireNativeChatSessionOptionLease(
        scope,
        createNativeChatSessionOptionOwner(known, () => known)
      )?.release()
    })
    expect(api!.snapshot[0].kind).toMatchObject({ currentValue: 'opus' })
    liveBindings.set(scope, { ...unknown, providerSession: { key: 'session_id', id: 'A' } })
    update({ reportedModel: 'claude-sonnet-5' })
    expect(api!.snapshot[0].kind).toMatchObject({ currentValue: 'opus' })
    liveBindings.set(scope, unknown)
    update({ reportedModel: 'claude-sonnet-5' })
    expect(api!.snapshot[0].kind).toMatchObject({ currentValue: 'opus' })
    liveBindings.set(scope, { ...unknown, providerSession: { key: 'session_id', id: 'B' } })
    update({ reportedModel: 'claude-sonnet-5' })
    expect(api!.snapshot[0].kind).toMatchObject({ currentValue: 'sonnet' })
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
