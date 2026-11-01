import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../worktree/workspace-list-types'
import { SidebarSessionActionSheet } from './SidebarSessionActionSheet'
import { clearClosedSidebarSession, sidebarSessionAction } from './sidebar-session-action'
import { getSelectedSidebarSession, setSelectedSidebarSession } from './selected-sidebar-session'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetContent: 'ActionSheetContent' }))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: 'wt-1',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'main',
    displayName: 'Orca',
    path: '/orca',
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  setSelectedSidebarSession(null)
})

describe('SidebarSessionActionSheet', () => {
  it('offers open and close for that session, then confirms the close', async () => {
    const session = sidebarSessionAction(
      worktree({
        agents: [
          {
            paneKey: 'pane-1',
            parentPaneKey: null,
            state: 'working',
            agentType: 'codex',
            prompt: 'Fix the list',
            taskTitle: null,
            displayName: null,
            lastAssistantMessage: null,
            toolName: null,
            toolInput: null,
            interrupted: false,
            stateStartedAt: 1,
            updatedAt: 1
          }
        ]
      }),
      'pane-1',
      2_000
    )
    const onOpen = vi.fn()
    const onCloseSession = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(SidebarSessionActionSheet, {
          session,
          onDismiss: vi.fn(),
          onOpen,
          onCloseSession
        })
      )
    })
    expect(session.label).toBe('Fix the list')
    const sheet = renderer!.root.find((node) => String(node.type) === 'ActionSheetContent')
    expect(sheet.props.title).toBe('Fix the list')
    expect(sheet.props.titleLines).toBe(2)
    expect(sheet.props.actions.map((action: { id: string }) => action.id)).toEqual([
      'open',
      'close'
    ])
    expect(sheet.props.actions.map((action: { label: string }) => action.label)).toEqual([
      'Open Fix the list',
      'Close'
    ])
    expect(sheet.props.actions[0].lines).toBe(2)

    await act(async () => sheet.props.actions[0].onPress())
    expect(onOpen).toHaveBeenCalledWith(session)

    await act(async () => sheet.props.actions[1].onPress())
    expect(
      renderer!.root.findAll((node) => String(node.type) === 'ActionSheetContent')
    ).toHaveLength(0)
    const texts = renderer!.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.props.children)
    expect(texts).toContain('Close "Fix the list"?')
    const confirmMessage = renderer!.root.find(
      (node) =>
        String(node.type) === 'Text' &&
        String(node.props.children).includes('Close "Fix the list"?')
    )
    expect(confirmMessage.props.numberOfLines).toBe(2)

    const confirm = renderer!.root.findAll((node) => String(node.type) === 'Pressable')
    await act(async () => confirm[1].props.onPress())
    expect(onCloseSession).toHaveBeenCalledTimes(1)
    await act(async () => confirm[1].props.onPress())
    expect(onCloseSession).toHaveBeenCalledTimes(1)
  })

  it('opens on the actions again after the confirm step is dismissed', async () => {
    const session = sidebarSessionAction(worktree(), 'pane-1', 1)
    const props = {
      onDismiss: vi.fn(),
      onOpen: vi.fn(),
      onCloseSession: vi.fn()
    }
    await act(async () => {
      renderer = create(createElement(SidebarSessionActionSheet, { session, ...props }))
    })
    const sheet = renderer!.root.find((node) => String(node.type) === 'ActionSheetContent')
    await act(async () => sheet.props.actions[1].onPress())
    await act(async () => {
      renderer!.update(createElement(SidebarSessionActionSheet, { session: null, ...props }))
    })
    await act(async () => {
      renderer!.update(createElement(SidebarSessionActionSheet, { session, ...props }))
    })
    expect(
      renderer!.root.findAll((node) => String(node.type) === 'ActionSheetContent')
    ).toHaveLength(1)
  })
})

describe('clearClosedSidebarSession', () => {
  it('clears the highlight only when it is the session that closed', () => {
    const session = sidebarSessionAction(worktree(), 'pane-1', 1)
    setSelectedSidebarSession({ worktreeId: 'wt-1', paneKey: 'pane-1' })
    clearClosedSidebarSession(session)
    expect(getSelectedSidebarSession()).toBeNull()
    setSelectedSidebarSession({ worktreeId: 'wt-1', paneKey: 'other' })
    clearClosedSidebarSession(session)
    expect(getSelectedSidebarSession()?.paneKey).toBe('other')
  })
})
