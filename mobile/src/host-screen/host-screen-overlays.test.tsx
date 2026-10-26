import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('lucide-react-native', () => ({ Moon: 'Moon', Pin: 'Pin', PinOff: 'PinOff' }))
vi.mock('../agent-history/worktree-navigation-actions', () => ({
  buildWorktreeNavigationActions: () => []
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetContent: 'ActionSheetContent' }))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: 'ConfirmModal' }))
vi.mock('../components/NewWorktreeModalController', () => ({
  NewWorktreeModalController: 'NewWorktreeModalController'
}))
vi.mock('./workspace-options-sheet', () => ({ WorkspaceOptionsSheet: 'WorkspaceOptionsSheet' }))
vi.mock('./workspace-details-sheet', () => ({ WorkspaceDetailsSheet: 'WorkspaceDetailsSheet' }))

import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { Worktree } from '../worktree/workspace-list-types'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'
import { HostScreenOverlays } from './host-screen-overlays'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

async function renderSheet(row: Partial<Worktree>) {
  const controller = {
    actions: {},
    catalog: {},
    client: new FakeSession('connected'),
    connState: 'connected',
    existingWorktreePaths: [],
    hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
    hostId: 'host-1',
    settings: {},
    state: {
      actionTarget: { worktreeId: 'wt', repo: 'orca', branch: 'main', ...row },
      confirmDelete: null,
      view: INITIAL_MOBILE_VIEW,
      hostLabelById: new Map(),
      pinnedIds: new Set()
    }
  }
  await act(async () => {
    renderer = create(
      createElement(HostScreenOverlays, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the action sheet reads only these members; the drawers and pickers that read the rest are mocked.
        controller: controller as unknown as Parameters<typeof HostScreenOverlays>[0]['controller']
      })
    )
  })
  return {
    sheet: renderer!.root.find((node) => String(node.type) === 'ActionSheetContent'),
    details: renderer!.root.find((node) => String(node.type) === 'WorkspaceDetailsSheet')
  }
}

async function actionLabels(row: Partial<Worktree>): Promise<string[]> {
  const { sheet } = await renderSheet(row)
  return sheet.props.actions.map((action: { label: string }) => action.label)
}

describe('the workspace long-press sheet', () => {
  it("offers Sleep for the desktop's own workspace", async () => {
    expect(await actionLabels({})).toContain('Sleep')
  })

  it("does not offer Sleep for a server's workspace, which the desktop would sleep by its own id", async () => {
    expect(await actionLabels({ worktreeId: 'runtime:vm-wt', hostId: 'runtime:vm' })).toEqual([
      'Pin',
      'Delete'
    ])
  })
})
