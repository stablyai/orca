// @vitest-environment happy-dom
import { act } from 'react'

import { afterEach, expect, it, vi } from 'vitest'
import {
  createResumeModalFixture,
  offered,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'

import {
  createNativeChatRestartStore,
  type NativeChatRestartStore
} from './native-chat-resume-on-restart-store'
import type { RuntimeEnvironmentStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'

const rpc = vi.hoisted(() => vi.fn<RestartRpc>())
const stream: ResumeStatusStream = vi.hoisted(() => ({ emit: () => {}, snapshot: new Map() }))
vi.mock('../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: rpc
}))

vi.mock('../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: ResumeStatusStream['emit']
  ) => {
    stream.emit = emit
    emit({ type: 'snapshot', sessions: [] })
    return {
      unsubscribe: () => {}
    }
  }
}))
vi.mock('sonner', async () =>
  (await import('./native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)
createResumeModalFixture(rpc, stream)
const stores: NativeChatRestartStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    store._resetNativeChatRestartOffer()
    store.consumeNativeChatResumeOnRestartDialogRequest()
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
function store() {
  const value = createNativeChatRestartStore({ kind: 'environment', environmentId: 'ssh' })
  stores.push(value)
  vi.stubGlobal('api', { runtimeEnvironments: { desktopCreatedChatIds: async () => ['a'] } })
  return value
}
function ready(runtimeId: string): RuntimeEnvironmentStatus {
  return {
    checkedAt: 0,
    status: {
      runtimeId,
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    }
  }
}

it('snoozes server failures locally through reconnect and reopens for a new runtime', async () => {
  const remote = store()
  rpc.mockResolvedValue({ sessions: offered })
  await act(async () => remote.observeRuntimeStatus(ready('first')))
  await remote.dismissNativeChatRestartOffer(['a'])
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(remote.getNativeChatRestartOffer().candidates).toHaveLength(2)
  remote.observeRuntimeStatus(undefined)
  await act(async () => remote.observeRuntimeStatus(ready('first')))
  expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(false)
  await act(async () => remote.observeRuntimeStatus(ready('second')))
  expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(true)
})

it.each(['failure', 'success', 'history'])(
  'supersedes an older ordinary read through all awaits (%s)',
  async (mode) => {
    const remote = store()
    rpc.mockResolvedValue({ sessions: offered })
    await act(async () => remote.observeRuntimeStatus(ready('r1')))
    const old = Promise.withResolvers<unknown>()
    const history = Promise.withResolvers<string[]>()
    if (mode === 'history') {
      vi.stubGlobal('api', {
        runtimeEnvironments: { desktopCreatedChatIds: () => history.promise }
      })
      rpc.mockResolvedValueOnce({ sessions: [] })
      await act(async () => remote.refreshNativeChatRestartOffer())
      rpc.mockResolvedValue({ sessions: offered })
    } else {
      rpc.mockReturnValueOnce(old.promise)
    }
    let read: Promise<void>
    await act(async () => {
      read = remote.refreshNativeChatRestartOffer()
    })
    rpc.mockResolvedValue({ sessions: mode === 'failure' ? offered : [] })
    remote.observeRuntimeStatus(undefined)
    await act(async () => remote.observeRuntimeStatus(ready('r1')))
    await act(async () => {
      if (mode === 'failure') {
        old.reject(new Error('obsolete failure'))
      } else {
        old.resolve({ sessions: offered })
      }
      history.resolve(['a'])
      await read!
    })
    expect(remote.getNativeChatRestartOffer().candidates).toHaveLength(mode === 'failure' ? 2 : 0)
    expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(mode === 'failure')
  }
)
