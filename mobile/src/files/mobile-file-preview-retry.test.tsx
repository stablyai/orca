import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Save: 'Icon' }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: () => {}, canGoBack: () => false })
}))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./MobileFileMarkdownPreview', () => ({ MobileFileMarkdownPreview: () => null }))
vi.mock('./MobileFilePreviewSourceText', () => ({ MobileFilePreviewSourceText: () => null }))
// A host the shell has not reached by default: no client, so the screen settles on `waiting`.
vi.mock('../transport/client-context', () => ({
  useForceReconnect: () => transport.forceReconnect,
  useHostClient: () => ({ ...transport.connection, clientId: null })
}))

import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  transport.connection = { client: null, state: 'reconnecting' }
})

// One object for every render, so a re-render changes nothing the preview keys on but the client.
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
    const sendRequest = vi.fn(() => new Promise(() => {}))
    transport.connection = { client: { sendRequest }, state: 'connected' }
    await act(async () => {
      rendered.update(createElement(MobileFilePreviewScreen, { route: ROUTE }))
    })
    expect(sendRequest).toHaveBeenCalled()
  })
})
