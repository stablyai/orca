vi.mock('./MobileFileMediaPreview', () => ({ MobileFileMediaPreview: () => null }))
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Save: 'Icon' }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: () => {}, canGoBack: () => false, push })
}))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./MobileFileMarkdownPreview', () => ({
  MobileFileMarkdownPreview: 'MobileFileMarkdownPreview'
}))
vi.mock('../components/MobileSourceCopyButton', () => ({ MobileSourceCopyButton: () => null }))
vi.mock('./MobileFilePreviewSourceText', () => ({ MobileFilePreviewSourceText: () => null }))
// No shell client initially: the screen must settle on waiting.
vi.mock('../transport/host-client-hooks', () => ({
  useForceReconnect: () => transport.forceReconnect,
  useHostClient: () => ({ ...transport.connection, clientId: null })
}))

import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import type { ExecutionHostId } from '../../../src/shared/execution-host'

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
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

function retryButtons(rendered: ReactTestRenderer): ReactTestInstance[] {
  return rendered.root
    .findAll((node) => String(node.type) === 'Pressable')
    .filter((node) =>
      node
        .findAll((text) => String(text.type) === 'Text')
        .some((text) => text.props.children === 'Retry')
    )
}

describe('the file preview Retry while the host is unreachable', () => {
  it('is absent on the page, where the only retry is a re-dial it cannot make', async () => {
    transport.forceReconnect = null
    const rendered = await render()
    expect(
      rendered.root.findAll((node) => node.props.children === 'Waiting for desktop...')
    ).not.toHaveLength(0)
    expect(retryButtons(rendered)).toHaveLength(0)
  })

  it('still renders natively and re-dials this host', async () => {
    const forceReconnect = vi.fn(() => Promise.resolve())
    transport.forceReconnect = forceReconnect
    const [retry] = retryButtons(await render())
    await act(async () => {
      retry?.props.onPress()
    })
    expect(forceReconnect.mock.calls).toEqual([['host-a']])
  })

  it('loads again when the shell reconnects, which is what the missing Retry relies on', async () => {
    transport.forceReconnect = null
    const rendered = await render()
    expect(retryButtons(rendered)).toHaveLength(0)
    const sendRequest = vi.fn(async () => ({
      id: 'reconnected',
      ok: true,
      result: { content: '# Recovered preview', truncated: false, byteLength: 19 },
      _meta: { runtimeId: 'host' }
    }))
    transport.connection = { client: { sendRequest }, state: 'connected' }
    await act(async () => {
      rendered.update(createElement(MobileFilePreviewScreen, { route: ROUTE }))
    })
    expect(sendRequest).toHaveBeenCalledWith('files.read', {
      worktree: 'id:wt-1',
      relativePath: 'README.md'
    })
    expect(
      rendered.root.find((node) => String(node.type) === 'MobileFileMarkdownPreview').props.content
    ).toBe('# Recovered preview')
    expect(
      rendered.root.findAll((node) => node.props.children === 'Waiting for desktop...')
    ).toHaveLength(0)
  })
})

it('wires rendered file links through the preview screen to navigation', async () => {
  transport.connection = {
    state: 'connected',
    client: {
      sendRequest: vi.fn(async () => ({
        ok: true,
        id: '1',
        _meta: { runtimeId: 'runtime-1' },
        result: { content: '[Details](docs/details.md)', isBinary: false, truncated: false }
      }))
    }
  }
  const rendered = await render()
  const markdown = rendered.root.find((node) => String(node.type) === 'MobileFileMarkdownPreview')
  await act(async () => markdown.props.onOpenFile('docs/details.md'))
  expect(push).toHaveBeenCalledWith({
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    params: {
      hostId: 'host-a',
      worktreeId: 'wt-1',
      worktreeName: undefined,
      source: 'worktree',
      relativePath: 'docs/details.md'
    }
  })
})

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

it('ignores a stale rejected read after a newer reconnect read succeeds', async () => {
  const oldRead = pendingPreviewReply()
  serveReads(() => oldRead.promise)
  const rendered = await render()
  serveReads(async () => previewReply('# Current preview'))
  await act(async () => rendered.update(createElement(MobileFilePreviewScreen, { route: ROUTE })))
  await act(async () => oldRead.reject(new Error('Disconnected')))
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

it('preserves the dirty artifact identity when its route is normalized again', async () => {
  serveReads(async () => previewReply('Original'))
  const { rendered, editor, save } = await mountArtifact()
  await act(async () => editor().props.onChangeText('My unsaved changes'))
  await act(async () => {
    rendered.update(
      createElement(MobileFilePreviewScreen, {
        route: { ...ARTIFACT_ROUTE, params: { ...ARTIFACT_ROUTE.params } }
      })
    )
  })
  expect(editor().props.value).toBe('My unsaved changes')
  expect(save().props.disabled).toBe(false)
})

it('saves once for two taps in one frame and preserves edits made during the save', async () => {
  const pendingWrite = Promise.withResolvers<unknown>()
  const write = vi.fn(() => pendingWrite.promise)
  serveReads((method) =>
    method === 'files.writeTerminalArtifact' ? write() : Promise.resolve(previewReply('Original'))
  )
  const { editor, save } = await mountArtifact()
  await act(async () => editor().props.onChangeText('First edit'))
  const press = save().props.onPress
  await act(async () => {
    press()
    press()
  })
  expect(write).toHaveBeenCalledOnce()
  await act(async () => editor().props.onChangeText('Newer edit'))
  await act(async () => pendingWrite.resolve({ ok: true, id: 'save', result: { written: true } }))
  expect(editor().props.value).toBe('Newer edit')
  expect(save().props.disabled).toBe(false)
})

it.each(['host', 'executionHost'] as const)(
  'does not carry a draft across %s authority with the same workspace and path',
  async (authority) => {
    serveReads(async () => previewReply('Original'))
    const withExecutionHost =
      (value: ExecutionHostId | undefined) => (screen: ReturnType<typeof createElement>) =>
        createElement(WorkspaceExecutionHostContext.Provider, { value }, screen)
    const { rendered, editor, save } = await mountArtifact(withExecutionHost(undefined))
    await act(async () => editor().props.onChangeText('My unsaved changes'))
    await act(async () => {
      rendered.update(
        withExecutionHost(authority === 'executionHost' ? 'runtime:other-server' : undefined)(
          createElement(MobileFilePreviewScreen, {
            route: {
              ...ARTIFACT_ROUTE,
              params: {
                ...ARTIFACT_ROUTE.params,
                hostId: authority === 'host' ? 'host-b' : 'host-a',
                grantId: 'grant-b'
              }
            }
          })
        )
      )
    })
    expect(editor().props.value).toBe('Original')
    expect(save().props.disabled).toBe(true)
  }
)
