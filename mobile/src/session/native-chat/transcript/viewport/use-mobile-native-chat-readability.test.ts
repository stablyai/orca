import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import '../../../floating-workspace'
import { useMobileNativeChatReadability } from './use-mobile-native-chat-readability'

describe('useMobileNativeChatReadability', () => {
  let renderer: ReactTestRenderer | null = null
  let readable = false

  beforeEach(() => {
    readable = false
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
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
  })
})
