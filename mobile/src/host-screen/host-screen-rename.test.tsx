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
vi.mock('lucide-react-native', () => ({
  Moon: 'Moon',
  Pin: 'Pin',
  PinOff: 'PinOff',
  Settings: 'Settings'
}))
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
vi.mock('./worktree-settings-panel', () => ({ WorktreeSettingsPanel: 'WorktreeSettingsPanel' }))

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

type SheetInputs = {
  renameWorktree?: (item: Worktree, draft: string) => Promise<unknown>
  worktreeSettingsTarget?: Partial<Worktree> | null
}

/** The long-press sheet for `row`, with the state setters it calls recorded. */
async function mountSheet(row: Partial<Worktree>, inputs: SheetInputs = {}) {
  const setters = {
    setActionTarget: vi.fn(),
    setConfirmDelete: vi.fn(),
    setWorktreeSettingsTarget: vi.fn()
  }
  const controller = {
    actions: { renameWorktree: inputs.renameWorktree ?? vi.fn() },
    catalog: {},
    client: new FakeSession('connected'),
    connState: 'connected',
    existingWorktreePaths: [],
    hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
    hostId: 'host-1',
    settings: {},
    showNewWorktree: false,
    state: {
      actionTarget: { worktreeId: 'wt', repo: 'orca', branch: 'main', ...row },
      confirmDelete: null,
      worktreeSettingsTarget: inputs.worktreeSettingsTarget ?? null,
      view: INITIAL_MOBILE_VIEW,
      hostLabelById: new Map(),
      pinnedIds: new Set(),
      ...setters
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
  return { root: renderer!.root, setters }
}

type SheetAction = { label: string; onPress: () => void }

async function sheetActions(row: Partial<Worktree>): Promise<SheetAction[]> {
  const { root } = await mountSheet(row)
  return root.find((node) => String(node.type) === 'ActionSheetContent').props.actions
}

/** The long-press sheet's action labels for `row`. */
async function actionLabels(row: Partial<Worktree>): Promise<string[]> {
  return (await sheetActions(row)).map((action) => action.label)
}

describe('the workspace long-press sheet', () => {
  it("offers Sleep for the desktop's own workspace", async () => {
    expect(await actionLabels({})).toContain('Sleep')
  })

  it("does not offer Sleep for a server's workspace, which the desktop would sleep by its own id", async () => {
    expect(await actionLabels({ worktreeId: 'runtime:vm-wt', hostId: 'runtime:vm' })).toEqual([
      'Worktree Settings',
      'Pin',
      'Delete'
    ])
  })

  it('leads with Worktree Settings, which opens the settings page for that row', async () => {
    const { root, setters } = await mountSheet({ displayName: 'Feature A' })
    const [first] = root.find((node) => String(node.type) === 'ActionSheetContent').props
      .actions as SheetAction[]
    expect(first?.label).toBe('Worktree Settings')
    act(() => first?.onPress())
    expect(setters.setWorktreeSettingsTarget).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt', displayName: 'Feature A' })
    )
    expect(setters.setActionTarget).not.toHaveBeenCalled()
  })
})

describe('the Worktree Settings page of the long-press sheet', () => {
  const target = { worktreeId: 'wt', repo: 'orca', branch: 'main', displayName: 'Feature A' }

  async function savePanel(outcome: unknown) {
    const renameWorktree = vi.fn(async () => outcome)
    const sheet = await mountSheet(target, { renameWorktree, worktreeSettingsTarget: target })
    const panel = sheet.root.find((node) => String(node.type) === 'WorktreeSettingsPanel')
    expect(sheet.root.findAll((node) => String(node.type) === 'ActionSheetContent')).toEqual([])
    let result: unknown
    await act(async () => {
      result = await panel.props.onSave('Renamed')
    })
    return { ...sheet, panel, renameWorktree, result }
  }

  it('replaces the action list and closes the sheet once the host accepted the name', async () => {
    const { panel, renameWorktree, result, setters } = await savePanel({ ok: true })
    expect(panel.props.target).toMatchObject({ worktreeId: 'wt' })
    expect(renameWorktree).toHaveBeenCalledWith(expect.objectContaining(target), 'Renamed')
    expect(result).toEqual({ ok: true })
    expect(setters.setWorktreeSettingsTarget).toHaveBeenCalledWith(null)
    expect(setters.setActionTarget).toHaveBeenCalledWith(null)
  })

  it('stays open on a refused name so the page can show why', async () => {
    const refused = { ok: false, error: 'Worktree not found' }
    const { result, setters } = await savePanel(refused)
    expect(result).toEqual(refused)
    expect(setters.setActionTarget).not.toHaveBeenCalled()
  })
})
