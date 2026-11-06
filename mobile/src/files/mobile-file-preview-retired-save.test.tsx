import { createElement, useState, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'
import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'
import type { MobileFilePreviewRouteState } from './mobile-file-preview-route'

const transport = vi.hoisted(() => ({
  sendRequest: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  leave: () => {},
  refuseBack: false
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: { View: 'View' },
  Alert: { alert: vi.fn() },
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Image: 'Image',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 })
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Save: 'Icon' }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: () => transport.leave() })
}))
vi.mock('../transport/use-workspace-client', () => ({
  useWorkspaceClient: () => ({ client: transport, state: 'connected' })
}))
vi.mock('../transport/host-client-hooks', () => ({
  useForceReconnect: () => null,
  useHostClient: () => ({ client: transport, state: 'connected', clientId: 'client' })
}))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))
vi.mock('./MobileFileMediaPreview', () => ({ MobileFileMediaPreview: () => null }))
vi.mock('./MobileFileMarkdownPreview', () => ({ MobileFileMarkdownPreview: () => null }))
vi.mock('../components/MobileSourceCopyButton', () => ({ MobileSourceCopyButton: () => null }))
vi.mock('./MobileFilePreviewSourceText', () => ({ MobileFilePreviewSourceText: () => null }))

const route = {
  ok: true,
  params: {
    hostId: 'host',
    worktreeId: 'folder:/project',
    source: 'terminalArtifact',
    absolutePath: '/project/draft.txt',
    terminal: 'pty',
    pathText: './draft.txt',
    grantId: 'grant'
  }
} as const

function accepted(result: unknown) {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'desktop' } }
}
function text(content: string) {
  return accepted({ content, truncated: false, byteLength: content.length })
}
function deferred() {
  const { promise, resolve } = Promise.withResolvers<unknown>()
  return { promise, resolve }
}
let renderer: ReactTestRenderer | null = null
function Session({ target = route }: { target?: MobileFilePreviewRouteState }) {
  const [open, setOpen] = useState(true)
  transport.leave = () => {
    if (!transport.refuseBack) {
      setOpen(false)
    }
  }
  return open ? createElement(MobileFilePreviewScreen, { route: target }) : null
}
function root() {
  if (!renderer) {
    throw new Error('preview not mounted')
  }
  return renderer.root
}
function labeled(label: string) {
  return findAllByHostType(root(), 'Pressable').find(
    (node) => node.props.accessibilityLabel === label
  )!
}

async function editAndSave() {
  await act(async () => {
    renderer = create(createElement(Session))
  })
  act(() => findAllByHostType(root(), 'TextInput')[0].props.onChangeText('Discarded draft'))
  act(() => labeled('Save terminal artifact').props.onPress())
}
beforeEach(() => {
  transport.sendRequest.mockReset()
  transport.refuseBack = false
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('file saves after the preview document is discarded', () => {
  it('does not write a departed document after the route opens a different file', async () => {
    const verification = deferred()
    let reads = 0
    transport.sendRequest.mockImplementation(async (method) =>
      method === 'files.readTerminalArtifact'
        ? ++reads === 2
          ? verification.promise
          : text(reads === 1 ? 'Original' : 'New file')
        : accepted({ ok: true })
    )
    await editAndSave()
    await act(async () =>
      renderer?.update(
        createElement(Session, {
          target: { ...route, params: { ...route.params, absolutePath: '/project/new.txt' } }
        })
      )
    )
    await act(async () => verification.resolve(text('Original')))
    expect(findAllByHostType(root(), 'TextInput')[0].props.value).toBe('New file')
    expect(transport.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'files.readTerminalArtifact',
      'files.readTerminalArtifact',
      'files.readTerminalArtifact'
    ])
  })

  it('saves an active document and keeps a newer edit dirty', async () => {
    const write = deferred()
    transport.sendRequest.mockImplementation(async (method) =>
      method === 'files.readTerminalArtifact' ? text('Original') : write.promise
    )
    await editAndSave()
    await act(async () => {})
    act(() => findAllByHostType(root(), 'TextInput')[0].props.onChangeText('Newer draft'))
    await act(async () => write.resolve(accepted({ ok: true })))
    expect(findAllByHostType(root(), 'TextInput')[0].props.value).toBe('Newer draft')
    expect(labeled('Save terminal artifact').props.disabled).toBe(false)
    expect(transport.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'files.readTerminalArtifact',
      'files.readTerminalArtifact',
      'files.writeTerminalArtifact'
    ])
  })
})
