import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'expo-router'
import { getLastCachedWorktrees, setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from '../worktree/workspace-list-sections'
import { useMobileWorktreeKeyboardNavigation } from './use-mobile-worktree-keyboard-navigation'

const catalogRuntime = vi.hoisted(() => ({
  requests: [] as Array<{
    client: unknown
    hostId: string
    resolve: (value: unknown) => void
  }>
}))
const keyboardRuntime = vi.hoisted(() => ({
  onCommand: null as null | ((event: { actionId: string; key: string }) => void)
}))

vi.mock('../cache/worktree-cache', () => ({
  getLastCachedWorktrees: vi.fn(),
  setCachedWorktrees: vi.fn()
}))

vi.mock('../worktree/worktree-catalog-snapshot-client', () => ({
  WorktreeCatalogSnapshotClient: class {
    fetch(client: unknown, hostId: string): Promise<unknown> {
      return new Promise((resolve) => catalogRuntime.requests.push({ client, hostId, resolve }))
    }

    admit(pending: { worktrees: Worktree[] }): Worktree[] {
      return pending.worktrees
    }
  }
}))

vi.mock('./use-mobile-hardware-keyboard-commands', () => ({
  useMobileHardwareKeyboardCommands: (options: {
    onCommand: (event: { actionId: string; key: string }) => void
  }) => {
    keyboardRuntime.onCommand = options.onCommand
  }
}))

function worktree(worktreeId: string): Worktree {
  return {
    worktreeId,
    repoId: 'repo-id',
    repo: 'orca',
    branch: worktreeId,
    displayName: worktreeId,
    path: `/repo/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

function catalogRequest(hostId: string, index = 0) {
  const request = catalogRuntime.requests.filter((candidate) => candidate.hostId === hostId)[index]
  if (!request) {
    throw new Error(`Missing catalog request ${hostId}:${index}`)
  }
  return request
}

function keyboardCommandHandler() {
  if (!keyboardRuntime.onCommand) {
    throw new Error('Missing keyboard command handler')
  }
  return keyboardRuntime.onCommand
}

describe('useMobileWorktreeKeyboardNavigation', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    catalogRuntime.requests = []
    keyboardRuntime.onCommand = null
    vi.mocked(getLastCachedWorktrees).mockReset().mockReturnValue(null)
    vi.mocked(setCachedWorktrees).mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('does not install a catalog response after the route switches hosts', async () => {
    const firstClient = {} as RpcClient
    const secondClient = {} as RpcClient
    const router = { replace: vi.fn() } as unknown as Router

    function Harness(props: { client: RpcClient; hostId: string }): null {
      useMobileWorktreeKeyboardNavigation({
        ...props,
        connState: 'connected',
        context: 'app',
        router,
        worktreeId: undefined
      })
      return null
    }

    await act(async () => {
      renderer = create(createElement(Harness, { client: firstClient, hostId: 'host-a' }))
      await Promise.resolve()
    })
    await act(async () => {
      renderer?.update(createElement(Harness, { client: secondClient, hostId: 'host-b' }))
      await Promise.resolve()
    })

    const firstRequest = catalogRequest('host-a')
    const secondRequest = catalogRequest('host-b')
    await act(async () => {
      firstRequest.resolve({
        kind: 'response',
        pending: { worktrees: [worktree('worktree-a')] }
      })
      await Promise.resolve()
    })

    expect(setCachedWorktrees).not.toHaveBeenCalledWith('host-a', expect.anything(), {
      proven: true
    })

    await act(async () => {
      secondRequest.resolve({
        kind: 'response',
        pending: { worktrees: [worktree('worktree-b')] }
      })
      await Promise.resolve()
    })

    expect(setCachedWorktrees).toHaveBeenCalledWith('host-b', [worktree('worktree-b')], {
      proven: true
    })
  })

  it('cancels a pending navigation command when the route changes', async () => {
    const firstClient = {} as RpcClient
    const secondClient = {} as RpcClient
    const router = { replace: vi.fn() } as unknown as Router
    vi.mocked(getLastCachedWorktrees).mockImplementation((hostId) =>
      hostId === 'host-b' ? [worktree('worktree-b')] : null
    )

    function Harness(props: { client: RpcClient; hostId: string }): null {
      useMobileWorktreeKeyboardNavigation({
        ...props,
        connState: 'connected',
        context: 'app',
        router,
        worktreeId: undefined
      })
      return null
    }

    await act(async () => {
      renderer = create(createElement(Harness, { client: firstClient, hostId: 'host-a' }))
      await Promise.resolve()
    })
    act(() => keyboardCommandHandler()({ actionId: 'worktree.navigateDown', key: 'ArrowDown' }))
    const pendingCommand = catalogRequest('host-a', 1)

    await act(async () => {
      renderer?.update(createElement(Harness, { client: secondClient, hostId: 'host-b' }))
      await Promise.resolve()
    })
    await act(async () => {
      pendingCommand.resolve({
        kind: 'response',
        pending: { worktrees: [worktree('worktree-a')] }
      })
      await Promise.resolve()
    })

    expect(router.replace).not.toHaveBeenCalled()
  })
})
