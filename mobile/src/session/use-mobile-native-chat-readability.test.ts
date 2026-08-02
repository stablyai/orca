import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { FLOATING_WORKSPACE_WORKTREE_ID } from './floating-workspace'
import { useMobileNativeChatReadability } from './use-mobile-native-chat-readability'

describe('useMobileNativeChatReadability', () => {
  let renderer: ReactTestRenderer | null = null
  let readable = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    readable = false
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function mount(
    connectionId: string | null,
    worktreeId = 'repo::/worktree'
  ): Promise<ReturnType<typeof vi.fn>> {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { repos: [{ id: 'repo', connectionId }] }
    })
    const client = {
      sendRequest
    } as unknown as RpcClient
    function Harness(): null {
      readable = useMobileNativeChatReadability(client, worktreeId)
      return null
    }
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
        await Promise.resolve()
      })
    } finally {
      consoleSpy.mockRestore()
    }
    return sendRequest
  }

  it('admits local and runtime-owned transcript hosts', async () => {
    await mount(null)
    expect(readable).toBe(true)
    act(() => renderer?.unmount())
    renderer = null

    await mount('runtime-ssh-environment')
    expect(readable).toBe(true)
  })

  it('fails closed for Model-A SSH transcript hosts', async () => {
    await mount('model-a-ssh')
    expect(readable).toBe(false)
  })

  it('treats the host-local floating workspace as readable without listing repos', async () => {
    const sendRequest = await mount(null, FLOATING_WORKSPACE_WORKTREE_ID)

    expect(readable).toBe(true)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('fails closed immediately while a reused route resolves its new worktree', async () => {
    let resolveNext: (response: unknown) => void = () => {}
    const client = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          result: { repos: [{ id: 'local-repo', connectionId: null }] }
        })
        .mockImplementationOnce(() => new Promise((resolve) => (resolveNext = resolve)))
    } as unknown as RpcClient
    function Harness({ worktreeId }: { worktreeId: string }): null {
      readable = useMobileNativeChatReadability(client, worktreeId)
      return null
    }
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { worktreeId: 'local-repo::/one' }))
        await Promise.resolve()
      })
      expect(readable).toBe(true)

      act(() => renderer?.update(createElement(Harness, { worktreeId: 'ssh-repo::/two' })))
      expect(readable).toBe(false)
      await act(async () => {
        resolveNext({
          ok: true,
          result: { repos: [{ id: 'ssh-repo', connectionId: 'model-a-ssh' }] }
        })
        await Promise.resolve()
      })
      expect(readable).toBe(false)
    } finally {
      consoleSpy.mockRestore()
    }
  })
})
