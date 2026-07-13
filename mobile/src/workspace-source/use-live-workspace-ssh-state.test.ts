import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import type { RpcClient } from '../transport/rpc-client'
import { useLiveWorkspaceSshState } from './use-live-workspace-ssh-state'

type HookState = ReturnType<typeof useLiveWorkspaceSshState>
type EventListener = (payload: unknown) => void

let current: HookState | null = null
let eventListener: EventListener | null = null
let renderer: ReactTestRenderer | null = null
const unsubscribe = vi.fn()
const sendRequest = vi.fn()
const subscribe = vi.fn(
  (_method: string, _params: unknown, listener: EventListener): (() => void) => {
    eventListener = listener
    return unsubscribe
  }
)
const client = { sendRequest, subscribe } as unknown as RpcClient

function sshState(status: SshConnectionState['status'], targetId = 'ssh-1'): SshConnectionState {
  return { targetId, status, error: null, reconnectAttempt: 0 }
}

function response(status: SshConnectionState['status'], targetId = 'ssh-1') {
  return {
    id: `ssh-state-${status}`,
    ok: true as const,
    result: { state: sshState(status, targetId) },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function Harness({ targetId = 'ssh-1' }: { targetId?: string }): null {
  current = useLiveWorkspaceSshState({ visible: true, client, targetId })
  return null
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => spy.mockRestore()
}

async function mountHook(targetId = 'ssh-1'): Promise<void> {
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(createElement(Harness, { targetId }))
      await Promise.resolve()
      await Promise.resolve()
    })
  } finally {
    restoreConsoleError()
  }
}

async function emit(payload: unknown): Promise<void> {
  await act(async () => {
    eventListener?.(payload)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useLiveWorkspaceSshState stream lifecycle', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    current = null
    eventListener = null
    sendRequest.mockReset()
    sendRequest.mockResolvedValue(response('connected'))
    subscribe.mockClear()
    unsubscribe.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('fails closed only on a ready replay and restores fresh SSH state', async () => {
    let resolveRefresh: ((value: ReturnType<typeof response>) => void) | null = null
    sendRequest.mockResolvedValueOnce(response('connected')).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    await mountHook()
    expect(current?.state?.status).toBe('connected')

    await emit({ type: 'ready', subscriptionId: 'runtime-events-1' })
    expect(current?.state?.status).toBe('connected')
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await emit({ type: 'ready', subscriptionId: 'runtime-events-2' })
    expect(current?.state).toBeNull()
    expect(current?.generation).toBe(1)

    act(() => resolveRefresh?.(response('disconnected')))
    await act(async () => {
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest).toHaveBeenNthCalledWith(2, 'ssh.getState', { targetId: 'ssh-1' })
    expect(current?.state?.status).toBe('disconnected')
    expect(current?.generation).toBe(2)
  })

  it('ignores connect completion after the selected target changes', async () => {
    let resolveConnect: ((value: ReturnType<typeof response>) => void) | null = null
    sendRequest.mockImplementation((method: string, params: { targetId: string }) => {
      if (method === 'ssh.connect') {
        return new Promise((resolve) => {
          resolveConnect = resolve
        })
      }
      return Promise.resolve(response('disconnected', params.targetId))
    })
    await mountHook()

    await act(async () => {
      void current?.connect()
      await Promise.resolve()
    })
    expect(current?.connecting).toBe(true)
    await act(async () => {
      renderer?.update(createElement(Harness, { targetId: 'ssh-2' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(current?.state).toEqual(sshState('disconnected', 'ssh-2'))
    const generationAfterSwitch = current?.generation

    act(() => resolveConnect?.(response('connected', 'ssh-1')))
    await act(async () => {
      await Promise.resolve()
    })

    expect(current?.state).toEqual(sshState('disconnected', 'ssh-2'))
    expect(current?.connecting).toBe(false)
    expect(current?.generation).toBe(generationAfterSwitch)
  })

  it('keeps a completed connect result when an earlier state read resolves late', async () => {
    let resolveRead: ((value: ReturnType<typeof response>) => void) | null = null
    sendRequest.mockImplementation((method: string) => {
      if (method === 'ssh.getState') {
        return new Promise((resolve) => {
          resolveRead = resolve
        })
      }
      return Promise.resolve(response('connected'))
    })
    await mountHook()

    await act(async () => {
      await current?.connect()
    })
    expect(current?.state).toEqual(sshState('connected'))

    act(() => resolveRead?.(response('disconnected')))
    await act(async () => {
      await Promise.resolve()
    })

    expect(current?.state).toEqual(sshState('connected'))
  })
})
