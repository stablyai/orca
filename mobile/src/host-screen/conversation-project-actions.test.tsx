import { createElement, type ReactNode, type ReactElement } from 'react'
import { Pressable, Text } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationProjectHeader } from './ConversationProjectHeader'
import { ConversationProjectActionsSheet } from './conversation-project-actions-sheet'
import { HiddenConversationProjectsSheet } from './hidden-conversation-projects-sheet'
import { conversationCopy } from './conversation-copy'
import type { ConversationProject } from './project-conversations'
import { conversationWorkspace } from './project-conversations.test-fixture'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { HostScreenController } from './use-host-screen-controller'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../components/MobileRepoIcon', () => ({ MobileRepoIcon: 'MobileRepoIcon' }))
vi.mock('lucide-react-native', () => ({
  Eye: 'Icon',
  EyeOff: 'Icon',
  Folder: 'Icon',
  Pin: 'Icon',
  PinOff: 'Icon',
  MoreHorizontal: 'Icon',
  Plus: 'Icon',
  Edit3: 'Icon',
  Trash2: 'Icon'
}))

const trees: ReactTestRenderer[] = []
afterEach(() =>
  act(() => {
    trees.forEach((tree) => tree.unmount())
    trees.length = 0
  })
)
async function mount(element: ReactElement) {
  let tree: ReactTestRenderer | undefined
  await act(async () => {
    tree = create(element)
    trees.push(tree)
  })
  if (!tree) {
    throw new Error('missing render')
  }
  return tree
}
const project: ConversationProject = {
  key: 'notes',
  title: 'Notes',
  hostId: 'local',
  data: [],
  workspaces: []
}

it('offers accessible options on a discovered group without inventing a new-chat target', async () => {
  const onOptions = vi.fn()
  const tree = await mount(
    createElement(ConversationProjectHeader, {
      project,
      connected: true,
      busy: null,
      onPrepare: vi.fn(),
      onOptions
    })
  )
  const buttons = tree.root.findAll((node) => node.type === Pressable)
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.props).toMatchObject({
    accessibilityRole: 'button',
    accessibilityLabel: `${conversationCopy().projectOptions}: Notes`
  })
  act(() => buttons[0]?.props.onPress())
  expect(onOptions).toHaveBeenCalledOnce()
  await act(async () =>
    tree.update(
      createElement(ConversationProjectHeader, {
        project: { ...project, workspaces: [conversationWorkspace()] },
        connected: true,
        busy: null,
        onPrepare: vi.fn(),
        onOptions
      })
    )
  )
  expect(tree.root.findAll((node) => node.type === Pressable)).toHaveLength(2)
})

it('uses neutral hide and restore actions and exposes disabled state on older hosts', async () => {
  const onHide = vi.fn()
  const controller = mountFixture<HostScreenController>({ connState: 'connected' })
  const tree = await mount(
    createElement(ConversationProjectActionsSheet, {
      project,
      controller,
      onClose: vi.fn(),
      onWorkspaces: vi.fn()
    })
  )
  const hide = () => tree.root.findAll((node) => node.type === Pressable).at(-1)
  expect(hide()?.props).toMatchObject({
    accessibilityRole: 'button',
    disabled: true,
    accessibilityState: { disabled: true }
  })
  expect(
    tree.root.findAll((node) => node.type === Text).map((node) => node.props.children)
  ).toContain(conversationCopy().keepFiles)
  await act(async () =>
    tree.update(
      createElement(ConversationProjectActionsSheet, {
        project,
        controller,
        onClose: vi.fn(),
        onWorkspaces: vi.fn(),
        onHide
      })
    )
  )
  expect(hide()?.props.accessibilityState.disabled).toBe(false)
  act(() => hide()?.props.onPress())
  expect(onHide).toHaveBeenCalledOnce()
  const onRestore = vi.fn()
  await act(async () =>
    tree.update(
      createElement(HiddenConversationProjectsSheet, {
        visible: true,
        projects: { notes: 'Notes' },
        connected: true,
        writing: false,
        supported: true,
        onClose: vi.fn(),
        onRestore
      })
    )
  )
  act(() => tree.root.find((node) => node.type === Pressable).props.onPress())
  expect(onRestore).toHaveBeenCalledWith('notes', 'Notes')
})
