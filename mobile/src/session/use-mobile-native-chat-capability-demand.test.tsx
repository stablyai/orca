import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Animated } from 'react-native'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from '../transport/mobile-runtime-client-capabilities'
import type { MobileCommandMenuHostFixtureModule } from '../../../src/shared/mobile-queued-edit-host.test-fixture-contract'
import { useMobileSessionFeedbackCapabilities } from './use-mobile-session-feedback-capabilities'
import { useMobileSessionTabReconciliation } from './use-mobile-session-tab-reconciliation'
import { useMobileNativeChatSessionLane } from './use-mobile-native-chat-session-lane'
import { resolveMobileNativeChat } from './native-chat/mobile-native-chat-eligibility'
import { useMobileNativeChatStructuredComposer } from './native-chat/composer/use-mobile-native-chat-structured-composer'
import { useMobileNativeChatComposerMenu } from './native-chat/composer/use-mobile-native-chat-composer-menu'

// Transcript/terminal services are outside this capability-to-command ownership contract.
vi.mock('./use-mobile-native-chat-session', () => ({ useMobileNativeChatSession: () => ({}) }))
vi.mock('./use-mobile-structured-agent-session', () => ({
  useMobileStructuredAgentSession: () => ({ session: {} })
}))
const terminal = vi.hoisted(() => ({ recover: vi.fn() }))
vi.mock('./use-mobile-session-tabs-reconciliation', () => ({
  useMobileSessionTabsReconciliation: () => ({ requestTerminalInventoryRecovery: terminal.recover })
}))
vi.mock('react-native', () => ({ Animated: { Value: class {} } }))
const { createMobileCommandMenuHostFixture } =
  await vi.importActual<MobileCommandMenuHostFixtureModule>(
    '../../../src/main/native-chat/agent-session-wire/mobile-queued-edit-host.test-fixture'
  )
type Host = Awaited<ReturnType<typeof createMobileCommandMenuHostFixture>>
const ok = (result: unknown): RpcResponse => ({ id: 'reply', ok: true, result })
const supported = () => ok({ capabilities: MOBILE_RUNTIME_CLIENT_CAPABILITIES })

function peer(host: Host) {
  const statuses: ReturnType<typeof Promise.withResolvers<RpcResponse>>[] = []
  let statusFailure: 'refusal' | 'timeout' | undefined,
    rejectCommands = false
  let responseGate: Promise<void> | undefined
  const send = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
    if (method === 'status.get') {
      if (statusFailure === 'timeout') {
        throw new Error('status timed out')
      }
      if (statusFailure === 'refusal') {
        return { id: 'refused', ok: false, error: { code: 'FORBIDDEN', message: 'Unavailable' } }
      }
      const status = Promise.withResolvers<RpcResponse>()
      statuses.push(status)
      return status.promise
    }
    if (method !== 'agentSession.commands') {
      throw new Error(`unexpected ${method}`)
    }
    if (rejectCommands) {
      return { id: 'refused', ok: false, error: { code: 'UNAVAILABLE', message: 'Unavailable' } }
    }
    if (typeof params !== 'object' || params === null || !('sessionId' in params)) {
      throw new Error('missing session')
    }
    const result = await host.request(String(params.sessionId), MOBILE_RUNTIME_CLIENT_CAPABILITIES)
    await responseGate
    return ok(result)
  })
  const client: RpcClient = {
    sendRequest: send,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return {
    client,
    statuses,
    calls: () => send.mock.calls.filter(([m]) => m === 'agentSession.commands').length,
    statusCalls: () => send.mock.calls.filter(([m]) => m === 'status.get').length,
    failStatus: (failure: 'refusal' | 'timeout' = 'timeout') => {
      statusFailure = failure
    },
    allowStatus: () => {
      statusFailure = undefined
    },
    failCommands: (fail: boolean) => {
      rejectCommands = fail
    },
    holdResponse: (gate?: Promise<void>) => {
      responseGate = gate
    }
  }
}

async function mounted(initial: ReturnType<typeof peer>, sessionId: string, connected = true) {
  let props: {
    peer: ReturnType<typeof peer>
    sessionId: string
    hostId: string
    connState: ConnectionState
  } = {
    peer: initial,
    sessionId,
    hostId: 'host',
    connState: connected ? 'connected' : 'reconnecting'
  }
  const base = {
    initialCreateWarning: '',
    sessionTabs: [],
    sessionTabsRef: { current: [] },
    activeSessionTabId: null,
    activeSessionTabIdRef: { current: null },
    activeSessionTab: null,
    markdownDocs: new Map(),
    markdownDocsRef: { current: new Map() },
    createWarningState: { source: '', visible: '' },
    setCreateWarningState: vi.fn(),
    setToastMessage: vi.fn(),
    onLiveInputSendFailureRef: { current: vi.fn() },
    toastOpacityRef: { current: new Animated.Value(0) },
    toastHideTimerRef: { current: null },
    toastSeqRef: { current: 0 },
    clientRef: { current: null },
    connStateRef: { current: 'connected' },
    activeSessionTabTypeRef: { current: null },
    delayedActionTimersRef: { current: new Set<ReturnType<typeof setTimeout>>() }
  } satisfies Partial<Parameters<typeof useMobileSessionFeedbackCapabilities>[0]>
  let current:
    | {
        support: ReturnType<typeof useMobileSessionFeedbackCapabilities>['agentSessionHostSupport']
        menu: ReturnType<typeof useMobileNativeChatComposerMenu>
        commands: ReturnType<typeof useMobileNativeChatSessionLane>['sessionCommands']['commands']
      }
    | undefined
  function Probe() {
    const input = { ...base, client: props.peer.client, connState: props.connState }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The checked subset supplies every feedback read; the unknown bridge omits unused composed controller fields, as in the toast-owner fixture.
    const feedbackScope = input as unknown as Parameters<
      typeof useMobileSessionFeedbackCapabilities
    >[0]
    const feedback = useMobileSessionFeedbackCapabilities(feedbackScope)
    const reconciliation = {
      ...input,
      ...feedback,
      worktreeId: 'menu-folder',
      setShowQuickCommands: vi.fn(),
      terminalGestureInputQueuesRef: { current: new Map() },
      terminalGestureInputInFlightRef: { current: new Set<string>() },
      registerTerminalInventoryRecoveryAction: () => () => {}
    } satisfies Partial<Parameters<typeof useMobileSessionTabReconciliation>[0]>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The checked subset supplies capability/reset effects; the unknown bridge omits callbacks used only by stubbed terminal reconciliation.
    const reconciliationScope = reconciliation as unknown as Parameters<
      typeof useMobileSessionTabReconciliation
    >[0]
    useMobileSessionTabReconciliation(reconciliationScope)
    const lane = useMobileNativeChatSessionLane({
      client: props.peer.client,
      hostId: props.hostId,
      structured: true,
      resolution: resolveMobileNativeChat({
        type: 'agent-session',
        agent: 'claude',
        sessionId: props.sessionId
      }),
      sourceIdentity: props.hostId,
      hostSupport: feedback.agentSessionHostSupport,
      appendComposerTextRef: { current: () => false },
      enabled: true,
      connState: props.connState,
      onSendError: () => {}
    })
    const structured = useMobileNativeChatStructuredComposer({
      structured: true,
      sessionCommands: lane.sessionCommands,
      acceptsFiles: false,
      conversationCommands: [],
      files: { files: [], attachFiles: async () => {}, removeFiles: () => {} }
    })
    const [value, setValue] = useState('')
    const menu = useMobileNativeChatComposerMenu({
      value,
      onChangeText: setValue,
      agent: 'claude',
      structuredCatalog: structured?.catalog,
      onSlashMenuOpen: structured?.onSlashMenuOpen,
      onSlashMenuDemand: structured?.onSlashMenuDemand,
      filePaths: [],
      focusField: () => {}
    })
    current = {
      support: feedback.agentSessionHostSupport,
      menu,
      commands: lane.sessionCommands.commands
    }
    return null
  }
  let tree: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(Probe))
  })
  const read = () => {
    if (!current) {
      throw new Error('unmounted probe')
    }
    return current
  }
  return {
    read,
    update: async (next: Partial<typeof props> = {}) => {
      props = { ...props, ...next }
      await act(async () => tree.update(createElement(Probe)))
    },
    draft: async (text: string) => {
      await act(async () => {
        read().menu.onFieldChange(text)
        read().menu.onSelectionChange({ start: text.length, end: text.length })
      })
    },
    dispose: async () => {
      await act(async () => tree.unmount())
    }
  }
}
const fast = (view: Awaited<ReturnType<typeof mounted>>) => {
  expect(view.read().commands?.some((row) => row.name === 'fast')).toBe(true)
  expect(view.read().menu.rows.some((row) => row.kind !== 'file' && row.token === '/fast')).toBe(
    true
  )
}
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

it.each([false, true])(
  'keeps the held-status eager boundary across retained reconnect=%s, then hands closed/open demand to support',
  async (reconnect) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const host = await createMobileCommandMenuHostFixture('claude', true)
    const source = peer(host),
      view = await mounted(source, host.sessionId, !reconnect)
    try {
      if (reconnect) {
        await view.update({ connState: 'connected' })
      }
      expect(source.calls()).toBe(1)
      expect(host.pending(host.sessionId)).toBe(true)
      await tick()
      expect(host.preparations()).toBe(1)
      expect(host.starts()).toBe(0)
      await act(async () => {
        source.statuses[0]!.resolve(supported())
      })
      expect(view.read().support?.commandsOnRequest).toBe(true)
      host.releasePreparation()
      await act(async () => {
        await vi.waitFor(() => expect(host.pending(host.sessionId)).toBe(false))
      })
      expect(host.starts()).toBe(1)
      expect(view.read().commands).toBeUndefined()
      for (let i = 0; i < 3; i++) {
        await view.update()
      }
      expect(source.calls()).toBe(1)
      await view.draft('/')
      await tick()
      fast(view)
      expect(source.calls()).toBe(2)
      expect(host.starts()).toBe(1)
      await view.draft('closed')
      await view.update({ connState: 'reconnecting' })
      expect(view.read().support).toBeNull()
      await view.update({ connState: 'connected' })
      await tick()
      expect(source.calls()).toBe(3)
      expect(host.starts()).toBe(1)
      await act(async () => {
        source.statuses.at(-1)!.resolve(supported())
      })
      await tick(60_000)
      expect(source.calls()).toBe(3)
    } finally {
      await view.dispose()
      await host.dispose()
      vi.useRealTimers()
    }
  }
)

it.each(['false', 'malformed', 'refusal', 'timeout'] as const)(
  'opens and settles a queued real menu refresh independently of status %s',
  async (outcome) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const host = await createMobileCommandMenuHostFixture('claude', true)
    const source = peer(host),
      view = await mounted(source, host.sessionId)
    try {
      const calls = source.calls()
      expect(calls).toBe(1)
      if (outcome === 'timeout' || outcome === 'refusal') {
        source.failStatus(outcome)
      }
      await act(async () => {
        const first = source.statuses[0]!
        if (outcome === 'false') {
          first.resolve(ok({ capabilities: [] }))
        } else if (outcome === 'malformed') {
          first.resolve(ok({ capabilities: 42 }))
        } else if (outcome === 'refusal') {
          first.resolve({
            id: 'refused',
            ok: false,
            error: { code: 'FORBIDDEN', message: 'Unavailable' }
          })
        } else {
          first.reject(new Error('status timed out'))
        }
      })
      if (outcome === 'false' || outcome === 'malformed') {
        expect(view.read().support?.commandsOnRequest).toBe(false)
      } else {
        expect(view.read().support).toBeNull()
      }
      await tick(1_000)
      await tick(2_000)
      expect(source.calls()).toBe(calls)
      if (outcome === 'timeout' || outcome === 'refusal') {
        expect(source.statusCalls()).toBe(3)
      }
      await view.draft('/')
      expect(source.calls()).toBe(calls)
      host.releasePreparation()
      await act(async () => {
        await vi.waitFor(() => expect(host.pending(host.sessionId)).toBe(false))
      })
      expect(host.starts()).toBe(1)
      expect(source.calls()).toBe(calls + 1)
      fast(view)
      source.failCommands(true)
      await view.draft('closed')
      await view.draft('/')
      expect(source.calls()).toBe(calls + 2)
      fast(view)
      const settled = source.calls()
      await tick(60_000)
      expect(source.calls()).toBe(settled)
    } finally {
      await view.dispose()
      await host.dispose()
      vi.useRealTimers()
    }
  }
)

it.each(['open-true', 'open-false', 'close-before-true'] as const)(
  'drains compatibility work and excludes late peer/session results: %s',
  async (schedule) => {
    const support = schedule !== 'open-false'
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const host = await createMobileCommandMenuHostFixture('claude', true, 2)
    const oldPeer = peer(host),
      view = await mounted(oldPeer, host.sessionId)
    try {
      await view.draft('/')
      if (schedule === 'close-before-true') {
        await view.draft('closed')
      }
      await act(async () => {
        oldPeer.statuses[0]!.resolve(support ? supported() : ok({ capabilities: [] }))
      })
      const handoff = oldPeer.calls()
      expect(handoff).toBe(schedule === 'open-true' ? 2 : 1)
      await view.draft('closed')
      const replacement = peer(host)
      const replacementReply = Promise.withResolvers<void>()
      replacement.holdResponse(replacementReply.promise)
      await view.update({ peer: replacement, hostId: 'other', sessionId: host.sessionIds[1]! })
      expect(view.read().support).toBeNull()
      expect(replacement.calls()).toBe(1)
      await view.draft('/')
      const retiredStatus = replacement.statuses[0]!
      await view.update({ connState: 'reconnecting' })
      await view.update({ connState: 'connected' })
      await act(async () => {
        retiredStatus.resolve(supported())
      })
      expect(view.read().support).toBeNull()
      await act(async () => {
        replacement.statuses.at(-1)!.resolve(supported())
      })
      await view.draft('closed')
      host.releasePreparation()
      await act(async () => {
        await vi.waitFor(() => {
          for (const id of host.sessionIds) {
            expect(host.pending(id)).toBe(false)
          }
        })
      })
      expect(host.starts()).toBe(2)
      expect(oldPeer.calls()).toBe(handoff + 1)
      expect(view.read().commands).toBeUndefined()
      await act(async () => {
        replacementReply.resolve()
      })
      expect(view.read().commands).toBeUndefined()
      const drained = replacement.calls()
      await tick(60_000)
      expect(replacement.calls()).toBe(drained)
      await view.draft('/')
      await tick()
      fast(view)
      await view.update({ sessionId: host.sessionId })
      await tick()
      fast(view)
    } finally {
      await view.dispose()
      await host.dispose()
      vi.useRealTimers()
    }
  }
)

it.each([3, 30])(
  'counts the permitted held-status wave at %s distinct contexts without status amplification',
  async (count) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const host = await createMobileCommandMenuHostFixture('claude', true, count)
    const sources = host.sessionIds.map(() => peer(host))
    const views: Awaited<ReturnType<typeof mounted>>[] = []
    try {
      for (const [i, source] of sources.entries()) {
        views.push(await mounted(source, host.sessionIds[i]!))
      }
      expect(sources.reduce((n, source) => n + source.calls(), 0)).toBe(count)
      for (const id of host.sessionIds) {
        expect(host.pending(id)).toBe(true)
      }
      await tick()
      expect(host.preparations()).toBe(count)
      expect(host.starts()).toBe(0)
      for (const source of sources) {
        source.failStatus()
        await act(async () => {
          source.statuses[0]!.reject(new Error('status timed out'))
        })
      }
      await tick(1_000)
      await tick(2_000)
      for (const source of sources) {
        expect(source.statusCalls()).toBe(3)
        expect(source.calls()).toBe(1)
      }
      // A real successful retry publishes support; it does not originate another closed-menu read.
      for (const source of sources) {
        source.allowStatus()
      }
      await tick(4_000)
      for (const source of sources) {
        await act(async () => {
          source.statuses.at(-1)!.resolve(supported())
        })
      }
      for (const view of views) {
        expect(view.read().support?.commandsOnRequest).toBe(true)
      }
      host.releasePreparation()
      await act(async () => {
        await vi.waitFor(() => {
          for (const id of host.sessionIds) {
            expect(host.pending(id)).toBe(false)
          }
        })
      })
      expect(host.starts()).toBe(count)
      for (const view of views) {
        await view.update()
      }
      for (const source of sources) {
        expect(source.calls()).toBe(1)
      }
    } finally {
      for (const view of views) {
        await view.dispose()
      }
      await host.dispose()
      vi.useRealTimers()
    }
  }
)
