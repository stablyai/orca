import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useLiveWorktreeName, type LiveWorktreeName } from './use-live-worktree-name'

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)): void {
      React.useEffect(effect, [effect])
    }
  }
})

describe('useLiveWorktreeName request volume', () => {
  let renderer: ReactTestRenderer | null = null
  let live: LiveWorktreeName | undefined
  let eventListener: ((payload: unknown) => void) | null = null
  const unsubscribeStream = vi.fn()
  const sendRequest = vi.fn().mockResolvedValue({
    id: 'worktree-show',
    ok: true,
    result: { worktree: { id: 'repo-1::/worktree', displayName: 'Live name' } },
    _meta: { runtimeId: 'runtime-1' }
  })
  const subscribe = vi.fn(
    (_method: string, _params: unknown, listener: (payload: unknown) => void) => {
      eventListener = listener
      return unsubscribeStream
    }
  )
  const client = { sendRequest, subscribe } as unknown as RpcClient

  const worktreeReadCount = () =>
    sendRequest.mock.calls.filter(([method]) => method === 'worktree.show').length

  async function mountHarness(): Promise<void> {
    function Harness(): null {
      live = useLiveWorktreeName({
        client,
        connState: 'connected',
        routeName: 'Route name',
        worktreeId: 'repo-1::/worktree'
      })
      return null
    }

    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })
  }

  async function emitEvent(payload: unknown): Promise<void> {
    await act(async () => {
      eventListener?.(payload)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    eventListener = null
    sendRequest.mockClear().mockResolvedValue({
      id: 'worktree-show',
      ok: true,
      result: { worktree: { id: 'repo-1::/worktree', displayName: 'Live name' } },
      _meta: { runtimeId: 'runtime-1' }
    })
    subscribe.mockClear()
    unsubscribeStream.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('stops worktree polling after the initial read and event-stream readiness', async () => {
    sendRequest.mockResolvedValue({
      id: 'worktree-show',
      ok: true,
      result: {
        worktree: {
          id: 'repo-1::/worktree',
          displayName: 'Live name',
          path: '/srv/project ',
          hostId: 'ssh:target'
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await mountHarness()
    expect(live).toMatchObject({ name: 'Live name', path: '/srv/project ', hostId: 'ssh:target' })
    expect(subscribe).toHaveBeenCalledWith(
      'runtime.clientEvents.subscribe',
      null,
      expect.any(Function)
    )
    expect(worktreeReadCount()).toBe(1)

    await emitEvent({ type: 'ready', subscriptionId: 'runtime-events-1' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(worktreeReadCount()).toBe(1)

    await emitEvent({ type: 'worktreesChanged', repoId: 'repo-2' })
    expect(worktreeReadCount()).toBe(1)

    await emitEvent({ type: 'worktreesChanged', repoId: 'repo-1' })
    expect(worktreeReadCount()).toBe(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(worktreeReadCount()).toBe(2)
  })

  it('reads the project on the workspace owner, refreshes renames and does not poll it while idle', async () => {
    let projectName = 'orca'
    sendRequest.mockImplementation(async (method) => ({
      id: method,
      ok: true,
      result:
        method === 'repo.show'
          ? { repo: { displayName: projectName } }
          : {
              worktree: { id: 'repo-1::/worktree', displayName: 'master', hostId: 'ssh:target' }
            },
      _meta: { runtimeId: 'runtime-1' }
    }))
    await mountHarness()
    expect(live).toMatchObject({ name: 'master', projectName: 'orca' })
    expect(sendRequest).toHaveBeenCalledWith('repo.show', {
      repo: 'id:repo-1',
      repoHostId: 'ssh:target'
    })
    await emitEvent({ type: 'ready', subscriptionId: 'events' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    projectName = 'Renamed project'
    await emitEvent({ type: 'reposChanged' })
    expect(live?.projectName).toBe('Renamed project')
  })

  it('ignores a late project reply after switching workspaces', async () => {
    let worktreeId = 'repo-1::/worktree'
    let finishFirst: (reply: RpcResponse) => void = () => {}
    sendRequest.mockImplementation((method) => {
      if (method === 'repo.show' && worktreeId.startsWith('repo-1')) {
        return new Promise<RpcResponse>((resolve) => {
          finishFirst = resolve
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result:
          method === 'repo.show'
            ? { repo: { displayName: 'Second project' } }
            : { worktree: { id: worktreeId, displayName: 'master' } }
      })
    })
    function Harness({ id }: { id: string }): null {
      live = useLiveWorktreeName({ client, connState: 'connected', worktreeId: id })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness, { id: worktreeId }))
    })
    worktreeId = 'repo-2::/other'
    await act(async () => {
      renderer?.update(createElement(Harness, { id: worktreeId }))
    })
    expect(live?.projectName).toBe('Second project')
    await act(async () => {
      finishFirst({ id: 'old', ok: true, result: { repo: { displayName: 'First project' } } })
    })
    expect(live).toMatchObject({ name: 'master', projectName: 'Second project' })
  })

  it('keeps polling when an older runtime rejects the event stream', async () => {
    await mountHarness()
    await emitEvent({ type: 'error', message: 'Unknown method' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000)
    })

    expect(worktreeReadCount()).toBe(4)
  })

  it('retries a failed initial read even after the event stream is ready', async () => {
    sendRequest.mockRejectedValueOnce(new Error('transient')).mockResolvedValue({
      id: 'worktree-show',
      ok: true,
      result: { worktree: { id: 'repo-1::/worktree', displayName: 'Live name' } },
      _meta: { runtimeId: 'runtime-1' }
    })
    await mountHarness()
    await emitEvent({ type: 'ready', subscriptionId: 'runtime-events-1' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(worktreeReadCount()).toBe(2)
  })

  it('refreshes once when a reconnected stream becomes ready again', async () => {
    await mountHarness()
    await emitEvent({ type: 'ready', subscriptionId: 'runtime-events-1' })
    await emitEvent({ type: 'ready', subscriptionId: 'runtime-events-2' })

    expect(worktreeReadCount()).toBe(2)
  })

  it('unsubscribes when the screen loses focus', async () => {
    await mountHarness()
    act(() => renderer?.unmount())
    renderer = null

    expect(unsubscribeStream).toHaveBeenCalledTimes(1)
  })

  it('never calls worktree.show for the floating workspace sentinel', async () => {
    let name = ''
    function FloatingHarness(): null {
      name = useLiveWorktreeName({
        client,
        connState: 'connected',
        routeName: undefined,
        worktreeId: 'global-floating-terminal'
      }).name
      return null
    }

    await act(async () => {
      renderer = create(createElement(FloatingHarness))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(sendRequest).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(name).toBe('Floating Workspace')
  })

  it('does not render stale names while switching through the floating route', async () => {
    const firstNameByWorktree = new Map<string, string>()
    let renderer: ReactTestRenderer | null = null

    function RouteHarness(props: { routeName?: string; worktreeId: string }): null {
      const { name } = useLiveWorktreeName({
        client,
        connState: 'connected',
        routeName: props.routeName,
        worktreeId: props.worktreeId
      })
      if (!firstNameByWorktree.has(props.worktreeId)) {
        firstNameByWorktree.set(props.worktreeId, name)
      }
      return null
    }

    try {
      await act(async () => {
        renderer = create(
          createElement(RouteHarness, {
            routeName: 'Previous workspace',
            worktreeId: 'repo-1::/worktree'
          })
        )
        await Promise.resolve()
      })
      await act(async () => {
        renderer?.update(
          createElement(RouteHarness, {
            worktreeId: 'global-floating-terminal'
          })
        )
      })
      await act(async () => {
        renderer?.update(
          createElement(RouteHarness, {
            routeName: 'Next workspace',
            worktreeId: 'repo-2::/worktree'
          })
        )
      })
    } finally {
      act(() => renderer?.unmount())
    }

    expect(firstNameByWorktree.get('global-floating-terminal')).toBe('Floating Workspace')
    expect(firstNameByWorktree.get('repo-2::/worktree')).toBe('Next workspace')
  })

  // The missing-workspace bounce shares this poll, so failure must publish a verdict rather than return silently.
  it('reports the host-proven verdict from the same poll', async () => {
    let resolution = ''
    function VerdictHarness(): null {
      resolution = useLiveWorktreeName({
        client,
        connState: 'connected',
        routeName: 'Route name',
        worktreeId: 'repo-1::/worktree'
      }).resolution
      return null
    }
    const mount = async (): Promise<void> => {
      await act(async () => {
        renderer = create(createElement(VerdictHarness))
        await Promise.resolve()
      })
    }

    await mount()
    expect(resolution).toBe('present')

    act(() => renderer?.unmount())
    renderer = null
    sendRequest.mockResolvedValue({
      id: 'worktree-show',
      ok: false,
      error: { code: 'selector_not_found', message: 'Selector not found' },
      _meta: { runtimeId: 'runtime-1' }
    })
    await mount()
    // A transient repo-scan rejection also reports selector_not_found; require a confirming poll.
    expect(resolution).toBe('unknown')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(resolution).toBe('missing')

    act(() => renderer?.unmount())
    renderer = null
    sendRequest.mockResolvedValue({
      id: 'worktree-show',
      ok: false,
      error: { code: 'runtime_busy', message: 'Runtime busy' },
      _meta: { runtimeId: 'runtime-1' }
    })
    await mount()
    expect(resolution).toBe('unknown')
  })
})
