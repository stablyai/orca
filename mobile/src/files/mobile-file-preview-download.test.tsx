vi.mock('./MobileFileMediaPreview', () => ({ MobileFileMediaPreview: () => null }))
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

const saver = vi.hoisted(() => ({ save: vi.fn(), cancel: vi.fn() }))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: { View: 'View' },
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
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  CircleAlert: 'Icon',
  Download: 'Icon',
  FileText: 'Icon',
  Save: 'Icon',
  WifiOff: 'Icon'
}))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: () => {}, canGoBack: () => false, push: () => {} })
}))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./MobileFileMarkdownPreview', () => ({
  MobileFileMarkdownPreview: 'MobileFileMarkdownPreview'
}))
vi.mock('../components/MobileSourceCopyButton', () => ({ MobileSourceCopyButton: () => null }))
vi.mock('./MobileFilePreviewSourceText', () => ({ MobileFilePreviewSourceText: () => null }))
vi.mock('../platform/file-saver', () => ({ useFileSaver: () => saver }))
// Stable identity: a new client each render would reload the preview forever.
const connection = vi.hoisted(() => ({
  client: {
    sendRequest: async () => ({
      ok: true,
      id: 'preview',
      _meta: { runtimeId: 'runtime-1' },
      result: { content: '# Title', truncated: false, byteLength: 7 }
    })
  },
  state: 'connected',
  clientId: null
}))
vi.mock('../transport/host-client-hooks', () => ({
  useForceReconnect: () => null,
  useHostClient: () => connection
}))

import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  saver.save.mockReset()
})

const MARKDOWN_ROUTE = {
  ok: true,
  params: { hostId: 'host-a', worktreeId: 'wt-1', relativePath: 'README.md' }
} as const

async function mountMarkdownAndDownload(): Promise<ReactTestRenderer> {
  await act(async () => {
    tree = create(createElement(MobileFilePreviewScreen, { route: MARKDOWN_ROUTE }))
  })
  if (tree === null) {
    throw new Error('the preview did not render')
  }
  const mounted = tree
  const button = mounted.root.findAll(
    (node) => node.props.accessibilityLabel === 'Download file'
  )[0]
  await act(async () => {
    button.props.onPress()
  })
  return mounted
}

const texts = (mounted: ReactTestRenderer) =>
  mounted.root.findAll((node) => String(node.type) === 'Text').map((node) => node.props.children)

it('shows the saved notice on a Markdown preview', async () => {
  saver.save.mockResolvedValue(true)
  expect(texts(await mountMarkdownAndDownload())).toContain('File saved')
})

it('shows the failure notice on a Markdown preview', async () => {
  saver.save.mockRejectedValue(new Error('boom'))
  expect(texts(await mountMarkdownAndDownload())).toContain('Unable to download this file')
})
