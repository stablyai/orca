import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import type { Worktree } from '../worktree/workspace-list-types'
import { useHostScreenState } from './use-host-screen-state'
import { useHostWorktreeActions } from './use-host-worktree-actions'

vi.mock('expo-router', () => ({}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: async () => {} }))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: () => {} }))

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
      const sendRequest = vi.fn(async (_method: string, _params: unknown, _options?: unknown) => ({
        ok: true,
        result: {}
      }))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this action only sends activation; the scoped client never uses its other methods.
      const client = { sendRequest } as unknown as RpcClient
      const row = { ...item, ...(executionHost ? { hostId: executionHost } : {}) }
      const held: { open?: (item: Worktree, paneKey?: string) => void } = {}
      function Probe() {
        const state = useHostScreenState('host', undefined)
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
