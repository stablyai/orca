import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import {
  requestMobileNativeChatStopLease,
  requestMobileNativeChatWriteLease,
  resetMobileNativeChatStopLeasesForTests
} from './mobile-native-chat-stop-lease'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'
import { useMobileNativeChatWriterGate } from './use-mobile-native-chat-writer-gate'

vi.mock('./mobile-image-source-picker', () => ({
  pickMobileImage: vi.fn(),
  ImageLibraryPermissionError: class ImageLibraryPermissionError extends Error {}
}))

import { pickMobileImage } from './mobile-image-source-picker'

const pick = vi.mocked(pickMobileImage)
type Hook = ReturnType<typeof useMobileNativeChatImageAttachments>
type HookArgs = Parameters<typeof useMobileNativeChatImageAttachments>[0]

function success(id: string, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function unavailable(id: string): RpcResponse {
  return {
    id,
    ok: false,
    error: { code: 'method_not_found', message: 'unavailable' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('useMobileNativeChatImageAttachments Stop ordering', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null
  const responses: RpcResponse[] = []
  const sendRequest = vi.fn(async () => {
    const response = responses.shift()
    if (!response) {
      throw new Error('unexpected request')
    }
    return response
  })

  function Harness({ args }: { args: HookArgs }): null {
    hook = useMobileNativeChatImageAttachments(args)
    return null
  }

  function GatedHarness({
    args,
    streamIdentity
  }: {
    args: HookArgs
    streamIdentity: string
  }): null {
    const gate = useMobileNativeChatWriterGate({
      client: args.client,
      enabled: args.enabled,
      handleRef: args.activeHandleRef as { current: string | null },
      streamIdentity
    })
    hook = useMobileNativeChatImageAttachments({ ...args, runWrite: gate.runWrite })
    return null
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    responses.splice(
      0,
      responses.length,
      unavailable('upload-start'),
      success('upload-save', '/tmp/image.png'),
      success('clear', { send: { accepted: true } }),
      success('paste', { send: { accepted: true } })
    )
    pick.mockResolvedValue({ base64: 'AAAA', uri: 'file:///image.jpg' })
    resetMobileNativeChatStopLeasesForTests()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    resetMobileNativeChatStopLeasesForTests()
  })

  it('waits for Stop before the first image paste write', async () => {
    let releaseWrite!: () => void
    const runWrite: HookArgs['runWrite'] = vi.fn(async (write, staleResult) => {
      await new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      return write(null).catch(() => staleResult)
    })
    const baseSend = vi.fn().mockResolvedValue('accepted')
    const args: HookArgs = {
      client: { sendRequest } as unknown as RpcClient,
      activeHandleRef: { current: 'terminal-1' },
      deviceTokenRef: { current: 'mobile-1' },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      scopeKey: 'host\0worktree\0tab',
      enabled: true,
      showToast: vi.fn(),
      onSendError: vi.fn(),
      baseSend,
      runWrite,
      readSeededLaunchDraft: () => null,
      sleep: async () => {}
    }
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...messages) => {
      if (
        typeof messages[0] === 'string' &&
        messages[0].includes('react-test-renderer is deprecated')
      ) {
        return
      }
      original(...messages)
    })
    try {
      act(() => {
        renderer = create(createElement(Harness, { args }))
      })
    } finally {
      spy.mockRestore()
    }
    await act(async () => hook!.attachImage('library'))

    let send!: Promise<boolean>
    act(() => {
      send = hook!.sendNativeChat('look')
    })
    await Promise.resolve()
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(baseSend).not.toHaveBeenCalled()

    await act(async () => releaseWrite())
    await expect(send).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(4)
    expect(baseSend).toHaveBeenCalledWith('look', ['file:///image.jpg'], expect.any(Number))
  })

  it('holds terminal ownership across image paste, settle, and message submit', async () => {
    let finishSubmit!: () => void
    const baseSend = vi.fn(
      () =>
        new Promise<'accepted'>((resolve) => {
          finishSubmit = () => resolve('accepted')
        })
    )
    const runWrite: HookArgs['runWrite'] = async (write, staleResult) => {
      const lease = await requestMobileNativeChatWriteLease('terminal-1').acquired
      if (!lease) {
        return staleResult
      }
      try {
        return await write({
          lease,
          terminal: 'terminal-1',
          isCurrent: () => true
        })
      } finally {
        lease.release()
      }
    }
    const args: HookArgs = {
      client: { sendRequest } as unknown as RpcClient,
      activeHandleRef: { current: 'terminal-1' },
      deviceTokenRef: { current: 'mobile-1' },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      scopeKey: 'host\0worktree\0tab',
      enabled: true,
      showToast: vi.fn(),
      onSendError: vi.fn(),
      baseSend,
      runWrite,
      readSeededLaunchDraft: () => null,
      sleep: async () => {}
    }
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })
    await act(async () => hook!.attachImage('library'))

    const send = hook!.sendNativeChat('look')
    for (let index = 0; index < 20 && !finishSubmit; index += 1) {
      await Promise.resolve()
    }
    const stop = requestMobileNativeChatStopLease('terminal-1')
    const stopStarted = vi.fn()
    void stop?.acquired.then(stopStarted)
    await Promise.resolve()
    expect(stopStarted).not.toHaveBeenCalled()

    finishSubmit()
    await expect(send).resolves.toBe(true)
    const stopLease = await stop?.acquired
    expect(stopStarted).toHaveBeenCalledOnce()
    stopLease?.release()
  })

  it('suppresses stale image admission callbacks from a replacement route', async () => {
    const onError = vi.fn()
    const onSendError = vi.fn()
    const args: HookArgs = {
      client: { sendRequest } as unknown as RpcClient,
      activeHandleRef: { current: 'terminal-1' },
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      scopeKey: 'host\0worktree\0old-tab',
      enabled: true,
      showToast: vi.fn(),
      onSendError,
      baseSend: vi.fn().mockResolvedValue('accepted'),
      runWrite: async (write) => write(null),
      readSeededLaunchDraft: () => null,
      onError,
      sleep: async () => {}
    }
    act(() => {
      renderer = create(
        createElement(GatedHarness, { args, streamIdentity: 'host\0worktree\0old-tab' })
      )
    })
    await act(async () => hook!.attachImage('library'))
    const stop = requestMobileNativeChatStopLease('terminal-1')
    const stopLease = await stop?.acquired

    const staleSend = hook!.sendNativeChat('old route')
    await Promise.resolve()
    act(() => {
      renderer!.update(
        createElement(GatedHarness, { args, streamIdentity: 'host\0worktree\0replacement-tab' })
      )
    })
    stopLease?.release()

    await expect(staleSend).resolves.toBe(false)
    expect(onError).not.toHaveBeenCalled()
    expect(onSendError).not.toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})
