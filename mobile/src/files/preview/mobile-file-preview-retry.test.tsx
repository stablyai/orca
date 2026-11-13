vi.mock('../media/MobileFileMediaPreview', () => ({ MobileFileMediaPreview: () => null }))
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

const push = vi.hoisted(() => vi.fn())
const transport = vi.hoisted(
  (): {
    forceReconnect: ((hostId: string) => Promise<void>) | null
    connection: { client: { sendRequest: (...args: unknown[]) => unknown } | null; state: string }
  } => ({
    forceReconnect: null,
    connection: { client: null, state: 'reconnecting' }
  })
)

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
  FileText: 'Icon',
  Save: 'Icon',
  WifiOff: 'Icon'
}))
vi.mock('../../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: () => {}, canGoBack: () => false, push })
}))
vi.mock('../../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('../markdown/MobileFileMarkdownPreview', () => ({
  MobileFileMarkdownPreview: 'MobileFileMarkdownPreview'
}))
vi.mock('../../components/MobileSourceCopyButton', () => ({ MobileSourceCopyButton: () => null }))
vi.mock('./MobileFilePreviewSourceText', () => ({ MobileFilePreviewSourceText: () => null }))
// No shell client initially: the screen must settle on waiting.
vi.mock('../../transport/connection/host-client-hooks', () => ({
  useForceReconnect: () => transport.forceReconnect,
  useHostClient: () => ({ ...transport.connection, clientId: null })
}))

import { MobileFilePreviewScreen } from '../MobileFilePreviewScreen'

import { resetDocumentEditDraftsForTests } from '../../drafts/document-edit-draft-rows'

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  // A page keeps unsaved edits for its whole life; each test is a fresh page.
  resetDocumentEditDraftsForTests()
  transport.connection = { client: null, state: 'reconnecting' }
})

// Keep identity stable so only the client changes across renders.
const ROUTE = {
  ok: true,
  params: { hostId: 'host-a', worktreeId: 'wt-1', relativePath: 'README.md' }
} as const

async function render(): Promise<ReactTestRenderer> {
  await act(async () => {
    tree = create(createElement(MobileFilePreviewScreen, { route: ROUTE }))
  })
  if (tree === null) {
    throw new Error('the preview did not render')
  }
  return tree
}

function previewReply(content: string, truncated = false) {
  return {
    ok: true,
    id: 'preview',
    _meta: { runtimeId: 'runtime-1' },
    result: { content, truncated, byteLength: content.length }
  }
}

function pendingPreviewReply() {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  return {
    promise,
    reject,
    text: (content: string, truncated = false) => resolve(previewReply(content, truncated))
  }
}

function serveReads(sendRequest: (method: unknown) => Promise<unknown>) {
  transport.connection = { state: 'connected', client: { sendRequest } }
}

const ARTIFACT_ROUTE = {
  ok: true,
  params: {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    source: 'terminalArtifact',
    absolutePath: '/workspace/draft.txt',
    grantId: 'grant-1'
  }
} as const

async function mountArtifact(wrap = (screen: ReturnType<typeof createElement>) => screen) {
  await act(async () => {
    tree = create(wrap(createElement(MobileFilePreviewScreen, { route: ARTIFACT_ROUTE })))
  })
  if (!tree) {
    throw new Error('Preview did not mount')
  }
  const rendered: ReactTestRenderer = tree
  return {
    rendered,
    editor: () => rendered.root.find((node) => String(node.type) === 'TextInput'),
    save: () =>
      rendered.root.find((node) => node.props.accessibilityLabel === 'Save terminal artifact')
  }
}

it('keeps the newest preview after overlapping reconnect reads settle out of order', async () => {
  const oldRead = pendingPreviewReply()
  serveReads(() => oldRead.promise)
  const rendered = await render()
  const newRead = pendingPreviewReply()
  serveReads(() => newRead.promise)
  await act(async () => rendered.update(createElement(MobileFilePreviewScreen, { route: ROUTE })))
  await act(async () => newRead.text('# Current preview'))
  await act(async () => oldRead.text('# Stale preview'))
  const markdown = rendered.root.find((node) => String(node.type) === 'MobileFileMarkdownPreview')
  expect(markdown.props.content).toBe('# Current preview')
})

it('keeps an editable dirty draft when a reconnect read returns a truncated file', async () => {
  serveReads(async () => previewReply('Original'))
  const { rendered, editor, save } = await mountArtifact()
  await act(async () => editor().props.onChangeText('My unsaved changes'))
  const refresh = pendingPreviewReply()
  serveReads(() => refresh.promise)
  await act(async () =>
    rendered.update(createElement(MobileFilePreviewScreen, { route: ARTIFACT_ROUTE }))
  )
  await act(async () => refresh.text('A truncated newer disk file', true))
  expect(editor().props.value).toBe('My unsaved changes')
  expect(save().props.disabled).toBe(false)
})
