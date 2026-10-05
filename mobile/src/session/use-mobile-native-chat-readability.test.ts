import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { FLOATING_WORKSPACE_WORKTREE_ID } from './floating-workspace'
import {
  useMobileNativeChatReadability,
  useMobileNativeChatReadabilityState
} from './use-mobile-native-chat-readability'
import type { MobileNativeChatReadability } from './mobile-session-chat-view'

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
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })
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

describe('useMobileNativeChatReadabilityState (A1c-8)', () => {
  let renderer: ReactTestRenderer | null = null
  let readability: MobileNativeChatReadability | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    readability = null
  })

  function Harness({ client, hostId }: { client: RpcClient | null; hostId: string }): null {
    readability = useMobileNativeChatReadabilityState(client, hostId, 'repo::/worktree')
    return null
  }

  function clientWith(sendRequest: ReturnType<typeof vi.fn>): RpcClient {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readability reaches the client only through sendRequest.
    return { sendRequest } as unknown as RpcClient
  }

  it('is unknown while the read is pending and settles from the reply', async () => {
    let answer: (response: unknown) => void = () => {}
    const client = clientWith(vi.fn(() => new Promise((resolve) => (answer = resolve))))
    await act(async () => {
      renderer = create(createElement(Harness, { client, hostId: 'host-pending' }))
    })
    expect(readability).toBe('unknown')
    await act(async () => {
      answer({ ok: true, result: { repos: [{ id: 'repo', connectionId: 'model-a-ssh' }] } })
      await Promise.resolve()
    })
    expect(readability).toBe('unreadable')
  })

  it('settles to failed when the read rejects', async () => {
    const client = clientWith(vi.fn().mockRejectedValue(new Error('timeout')))
    await act(async () => {
      renderer = create(createElement(Harness, { client, hostId: 'host-failed' }))
      await Promise.resolve()
    })
    expect(readability).toBe('failed')
  })

  it('keeps the settled answer for the same host while a swapped client re-reads', async () => {
    const first = clientWith(
      vi
        .fn()
        .mockResolvedValue({ ok: true, result: { repos: [{ id: 'repo', connectionId: null }] } })
    )
    await act(async () => {
      renderer = create(createElement(Harness, { client: first, hostId: 'host-swap' }))
      await Promise.resolve()
    })
    expect(readability).toBe('readable')
    const second = clientWith(vi.fn(() => new Promise(() => {})))
    act(() => renderer?.update(createElement(Harness, { client: second, hostId: 'host-swap' })))
    expect(readability).toBe('readable')
    act(() => renderer?.update(createElement(Harness, { client: second, hostId: 'other-host' })))
    expect(readability).toBe('unknown')
  })

  it('retries a failed first read a bounded number of times (R2b-F3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const sendRequest = vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({
          ok: true,
          result: { repos: [{ id: 'repo', connectionId: null }] }
        })
      await act(async () => {
        renderer = create(
          createElement(Harness, { client: clientWith(sendRequest), hostId: 'host-retry' })
        )
        await Promise.resolve()
      })
      expect(readability).toBe('failed')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(readability).toBe('readable')

      const failing = vi.fn().mockRejectedValue(new Error('timeout'))
      act(() => renderer?.unmount())
      await act(async () => {
        renderer = create(
          createElement(Harness, { client: clientWith(failing), hostId: 'host-retry-cap' })
        )
        await Promise.resolve()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(failing).toHaveBeenCalledTimes(4)
      expect(readability).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the stored answer when a re-read fails or no client is left (R1-F2, R4-n2)', async () => {
    const first = clientWith(
      vi
        .fn()
        .mockResolvedValue({ ok: true, result: { repos: [{ id: 'repo', connectionId: null }] } })
    )
    await act(async () => {
      renderer = create(createElement(Harness, { client: first, hostId: 'host-refail' }))
      await Promise.resolve()
    })
    const failing = clientWith(vi.fn().mockRejectedValue(new Error('timeout')))
    await act(async () => {
      renderer?.update(createElement(Harness, { client: failing, hostId: 'host-refail' }))
      await Promise.resolve()
    })
    expect(readability).toBe('readable')
    act(() => renderer?.update(createElement(Harness, { client: null, hostId: 'host-refail' })))
    expect(readability).toBe('readable')
  })
})
