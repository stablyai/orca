import { createElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const repo = { id: 'repo-1', displayName: 'App', path: '/app', kind: 'git' as const }
  return {
    repo,
    sourceDrawerVisible: false,
    setDrawerVisible: vi.fn((visible: boolean) => {
      fixture.sourceDrawerVisible = visible
    })
  }
})

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp'
}))

vi.mock('./BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('./PickerListDrawer', () => ({ PickerListDrawer: 'PickerListDrawer' }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('./MobileWorkspaceNameInput', () => ({ MobileWorkspaceNameInput: 'NameInput' }))
vi.mock('./NewWorkspaceSourceDrawer', () => ({
  NewWorkspaceSourceDrawer: 'NewWorkspaceSourceDrawer'
}))
vi.mock('./NewWorkspaceSourceField', () => ({
  NewWorkspaceSourceField: 'NewWorkspaceSourceField'
}))
vi.mock('../cache/repo-cache', () => ({
  getCachedRepos: () => [fixture.repo],
  setCachedRepos: vi.fn()
}))
vi.mock('../worktree/use-last-visited-worktree-repo', () => ({
  useLastVisitedWorktreeRepoId: () => ({ loaded: true, repoId: fixture.repo.id })
}))
vi.mock('../workspace-source/use-live-workspace-ssh-state', () => ({
  useLiveWorkspaceSshState: () => ({
    state: null,
    connecting: false,
    generation: 0,
    connect: vi.fn()
  })
}))
vi.mock('../workspace-source/use-new-workspace-source', () => ({
  useNewWorkspaceSource: () => ({
    name: { value: '', owner: 'blank' },
    source: null,
    availability: { github: true, branches: true, linear: false },
    sshStateGeneration: 0,
    fieldVisible: true,
    drawerVisible: fixture.sourceDrawerVisible,
    setDrawerVisible: fixture.setDrawerVisible,
    setManualName: vi.fn(),
    selectSource: vi.fn(),
    clearSource: vi.fn(),
    setReuseEnabled: vi.fn(),
    refreshLinearStatus: vi.fn()
  })
}))

import { NewWorktreeModal } from './NewWorktreeModal'

const client = {
  sendRequest: vi.fn(async (method: string) => {
    if (method === 'repo.list') {
      return { ok: true, result: { repos: [fixture.repo] } }
    }
    if (method === 'settings.get') {
      return { ok: true, result: { settings: {} } }
    }
    if (method === 'ui.get') {
      return { ok: true, result: { ui: {} } }
    }
    if (method === 'preflight.detectAgents') {
      return { ok: true, result: ['codex'] }
    }
    if (method === 'repo.hooks') {
      return { ok: true, result: { hooks: null, source: null } }
    }
    return { ok: true, result: {} }
  })
} as never

function modal(overrides: { existingWorktreePaths?: string[] } = {}) {
  return createElement(NewWorktreeModal, {
    visible: true,
    client,
    hostId: 'host-1',
    existingWorktreePaths: overrides.existingWorktreePaths,
    hostCapabilities: ['mobile.workspace-source-selector.v1'],
    onCreated: vi.fn(),
    onClose: vi.fn()
  })
}

function textContent(node: ReactTestInstance): string {
  return node
    .findAllByType('Text')
    .map((text) => text.props.children)
    .join(' ')
}

function fieldPress(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const field = renderer.root
    .findAllByType('Pressable')
    .find((node) => textContent(node).includes(label))
  if (!field) {
    throw new Error(`Missing ${label} field`)
  }
  return field
}

function visibleNativeLayers(renderer: ReactTestRenderer): ReactTestInstance[] {
  return [
    ...renderer.root.findAllByType('BottomDrawer'),
    ...renderer.root.findAllByType('PickerListDrawer'),
    ...renderer.root.findAllByType('NewWorkspaceSourceDrawer')
  ].filter((node) => node.props.visible === true)
}

function layer(renderer: ReactTestRenderer, type: string, title?: string): ReactTestInstance {
  return renderer.root
    .findAllByType(type)
    .find((node) => title === undefined || node.props.title === title)!
}

describe('NewWorktreeModal native drawer ownership', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    fixture.sourceDrawerVisible = false
    fixture.setDrawerVisible.mockClear()
    vi.mocked(client.sendRequest).mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function mount(): Promise<ReactTestRenderer> {
    await act(async () => {
      renderer = create(modal())
      await Promise.resolve()
      await Promise.resolve()
    })
    return renderer!
  }

  it('never presents a picker while the Create drawer still owns the native modal', async () => {
    const view = await mount()
    expect(visibleNativeLayers(view)).toHaveLength(1)

    act(() => fieldPress(view, 'App').props.onPress())
    expect(visibleNativeLayers(view)).toHaveLength(0)

    act(() => layer(view, 'BottomDrawer').props.onHidden())
    expect(visibleNativeLayers(view)).toHaveLength(1)
    expect(layer(view, 'PickerListDrawer', 'Repository').props.visible).toBe(true)

    act(() => layer(view, 'PickerListDrawer', 'Repository').props.onClose())
    expect(visibleNativeLayers(view)).toHaveLength(0)
    act(() => layer(view, 'PickerListDrawer', 'Repository').props.onHidden())
    expect(visibleNativeLayers(view)).toHaveLength(1)
  })

  it('preserves source and adjacent-picker ordering across parent refreshes', async () => {
    const view = await mount()
    const sourceField = () => layer(view, 'NewWorkspaceSourceField')

    fixture.sourceDrawerVisible = true
    act(() => {
      sourceField().props.onPrepareOpen()
      view.update(modal({ existingWorktreePaths: ['/app/first'] }))
    })
    expect(visibleNativeLayers(view)).toHaveLength(0)
    act(() => layer(view, 'BottomDrawer').props.onHidden())
    expect(layer(view, 'NewWorkspaceSourceDrawer').props.visible).toBe(true)

    act(() => layer(view, 'NewWorkspaceSourceDrawer').props.onClose())
    act(() => view.update(modal({ existingWorktreePaths: ['/app/second'] })))
    expect(visibleNativeLayers(view)).toHaveLength(0)
    act(() => layer(view, 'NewWorkspaceSourceDrawer').props.onHidden())
    expect(visibleNativeLayers(view)).toHaveLength(1)

    fixture.sourceDrawerVisible = true
    act(() => sourceField().props.onPrepareOpen())
    expect(visibleNativeLayers(view)).toHaveLength(0)
    act(() => layer(view, 'BottomDrawer').props.onHidden())
    expect(layer(view, 'NewWorkspaceSourceDrawer').props.visible).toBe(true)
    act(() => layer(view, 'NewWorkspaceSourceDrawer').props.onClose())
    act(() => layer(view, 'NewWorkspaceSourceDrawer').props.onHidden())
    expect(visibleNativeLayers(view)).toHaveLength(1)

    act(() => fieldPress(view, 'Codex').props.onPress())
    expect(visibleNativeLayers(view)).toHaveLength(0)
    act(() => layer(view, 'BottomDrawer').props.onHidden())
    expect(layer(view, 'PickerListDrawer', 'Agent').props.visible).toBe(true)
  })
})
