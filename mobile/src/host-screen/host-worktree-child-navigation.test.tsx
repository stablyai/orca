import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import { notificationPaneTab } from '../session/notification-pane-tab'
import type { MobileSessionTab } from '../session/mobile-session-route-types'
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
  preview: '',
  unread: false,
  isPinned: false,
  linkedPR: null
}
const sessionId = '10000000-0000-4000-8000-000000000000'
const nativeTabId = structuredAgentSessionTabId(sessionId)
const terminalKey = `terminal:${sessionId}`
const nativeKey = structuredAgentSessionPaneKey(nativeTabId, sessionId)
const tabs: MobileSessionTab[] = [
  {
    type: 'terminal',
    id: 'leaf',
    parentTabId: 'terminal',
    leafId: sessionId,
    title: 'Codex',
    terminal: 'term',
    isActive: false
  },
  {
    type: 'agent-session',
    id: nativeTabId,
    sessionId,
    agent: 'claude',
    title: 'Claude',
    isActive: false
  }
]

describe('a workspace child opens its parent pane', () => {
  it.each([terminalKey, nativeKey])(
    'selects %s even in the already-open embedded workspace',
    async (paneKey) => {
      const push = vi.fn()
      const replace = vi.fn()
      const held: { open?: (item: Worktree, paneKey?: string) => void } = {}
      function Probe() {
        const state = useHostScreenState('host', undefined)
        held.open = useHostWorktreeActions({
          client: null,
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
        held.open?.(item, paneKey)
      })
      const target = replace.mock.calls[0]?.[0]
      expect(target).toBe(
        `/h/host/session/folder-one?name=Folder&paneKey=${encodeURIComponent(paneKey)}`
      )
      expect(
        notificationPaneTab(tabs, new URLSearchParams(target.split('?')[1]).get('paneKey')!)
      ).toBe(tabs[paneKey === terminalKey ? 0 : 1])
      await act(async () => {
        held.open?.(item, paneKey)
      })
      expect(replace).toHaveBeenCalledTimes(2)
      await act(async () => {
        held.open?.(item)
      })
      expect(replace).toHaveBeenCalledTimes(2)
      expect(push).not.toHaveBeenCalled()
      await act(async () => {
        tree!.unmount()
      })
    }
  )
})
