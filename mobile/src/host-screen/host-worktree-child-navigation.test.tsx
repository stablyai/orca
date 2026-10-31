import { createElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import type { Worktree } from '../worktree/workspace-list-types'
import { useHostScreenState } from './use-host-screen-state'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import { useSessionLeaveGuard } from '../session/session-leave-guard'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}
function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

vi.mock('expo-router', () => ({}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: async () => {} }))
const leaveHostRoute = vi.hoisted(() => vi.fn())
vi.mock('../host-route-exit', () => ({ leaveHostRoute }))

const item: Worktree = {
  worktreeId: 'folder-one',
  workspaceKind: 'folder-workspace',
  repoId: 'repo',
  repo: 'app',
  branch: '',
  displayName: 'Folder',
  path: '/workspace',
  liveTerminalCount: 1,
  hasAttachedPty: true,
  unread: false,
  isPinned: false,
  linkedPR: null
}
const sessionId = '10000000-0000-4000-8000-000000000000'
const nativeTabId = structuredAgentSessionTabId(sessionId)
const terminalKey = `terminal:${sessionId}`
const nativeKey = structuredAgentSessionPaneKey(nativeTabId, sessionId)
describe('a workspace child opens its parent pane', () => {
  it.each([
    [terminalKey, undefined],
    [nativeKey, undefined],
    [terminalKey, 'runtime:server'],
    [nativeKey, 'runtime:server']
  ] as const)(
    'selects parent %s on %s through the workspace action',
    async (paneKey, executionHost) => {
      const push = vi.fn()
      const replace = vi.fn()
      const sendRequest = vi.fn(
        async (_method: string, _params: unknown, _options?: unknown): Promise<RpcResponse> => ({
          id: 'activate',
          ok: true,
          result: {}
        })
      )
      const client = stubRpcClient({ sendRequest })
      const row = { ...item, ...(executionHost ? { hostId: executionHost } : {}) }
      const held: { open?: (item: Worktree, paneKey?: string) => void } = {}
      function Probe() {
        const state = useHostScreenState('host')
        held.open = useHostWorktreeActions({
          client,
          hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
          connState: 'connected',
          embedded: true,
          fetchWorktrees: async () => {},
          forgetHostClient: () => {},
          hostId: 'host',
          pathname: '/h/host/session/folder-one',
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: navigation reaches only push/replace; this double records both router methods.
          router: { push, replace } as unknown as Parameters<
            typeof useHostWorktreeActions
          >[0]['router'],
          state
        }).openWorktreeSession
        return null
      }
      let tree: ReturnType<typeof create> | undefined
      await act(async () => {
        tree = create(createElement(Probe))
      })
      await act(async () => {
        held.open?.(row, paneKey)
      })
      const target = replace.mock.calls[0]?.[0]
      expect(target).toBe(
        `/h/host/session/folder-one?name=Folder${executionHost ? `&executionHost=${encodeURIComponent(executionHost)}` : ''}&paneKey=${encodeURIComponent(paneKey)}`
      )
      expect(sendRequest.mock.calls[0]?.slice(0, 2)).toEqual([
        'worktree.activate',
        {
          worktree: 'id:folder-one',
          notifyClients: false,
          navigation: 'caller'
        }
      ])
      expect(sendRequest.mock.calls[0]?.[2]).toEqual(
        executionHost ? { envelope: { executionHost } } : undefined
      )
      expect(push).not.toHaveBeenCalled()
      await act(async () => {
        tree!.unmount()
      })
    }
  )
})

async function tapWhileRecording(
  pathname: string,
  tap: (actions: ReturnType<typeof useHostWorktreeActions>) => void
) {
  const replace = vi.fn()
  const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
    id: 'activate',
    ok: true,
    result: {}
  }))
  // The recording session publishes a guard that holds the leave.
  const guard = vi.fn(() => true)
  const held: { actions?: ReturnType<typeof useHostWorktreeActions> } = {}
  function Probe() {
    useSessionLeaveGuard(guard)
    held.actions = useHostWorktreeActions({
      client: stubRpcClient({ sendRequest }),
      hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      connState: 'connected',
      embedded: true,
      fetchWorktrees: async () => {},
      forgetHostClient: () => {},
      hostId: 'host',
      pathname,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: navigation reaches only push/replace; this double records both router methods.
      router: { push: vi.fn(), replace } as unknown as Parameters<
        typeof useHostWorktreeActions
      >[0]['router'],
      state: useHostScreenState('host')
    })
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
  await act(async () => {
    if (held.actions) {
      tap(held.actions)
    }
  })
  return { replace, sendRequest, guard }
}

describe('a sidebar tap while the open session is recording', () => {
  it('stays without touching the other workspace', async () => {
    const tap = await tapWhileRecording('/h/host/session/other', (actions) =>
      actions.openWorktreeSession(item)
    )
    expect(tap.guard).toHaveBeenCalledTimes(1)
    expect(tap.replace).not.toHaveBeenCalled()
    expect(tap.sendRequest).not.toHaveBeenCalled()
  })

  it('keeps recording when the tap is on the open session itself', async () => {
    const tap = await tapWhileRecording('/h/host/session/folder-one', (actions) =>
      actions.openWorktreeSession(item)
    )
    expect(tap.guard).not.toHaveBeenCalled()
    expect(tap.replace).not.toHaveBeenCalled()
  })

  it('stays on Back to hosts too', async () => {
    const tap = await tapWhileRecording('/h/host/session/other', (actions) => actions.leaveHost())
    expect(tap.guard).toHaveBeenCalledTimes(1)
    expect(leaveHostRoute).not.toHaveBeenCalled()
  })
})

afterEach(unmountRenderers)
