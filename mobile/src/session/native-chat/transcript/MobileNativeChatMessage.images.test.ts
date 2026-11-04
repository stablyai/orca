import './mobile-agent-message-renderer.test-fixture'
import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let renderer: ReactTestRenderer | null = null
let sendRequest = vi.fn()

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

async function renderWithHost(node: ReactNode): Promise<ReactTestRenderer> {
  act(() => renderer?.unmount())
  sendRequest = vi.fn(async () => ({
    id: '1',
    ok: true,
    result: { content: PNG, isBinary: true, isImage: true, mimeType: 'image/png' }
  }))
  const value = {
    openImage: vi.fn(),
    openActions: vi.fn(),
    imageSource: { client: stubRpcClient({ sendRequest }), worktreeId: 'wt-1' }
  }
  await act(async () => {
    renderer = create(createElement(MobileNativeChatRowOverlaysContext.Provider, { value }, node))
  })
  return renderer!
}

function assistant(blocks: NativeChatMessage['blocks']) {
  const message: NativeChatMessage = {
    id: 'm1',
    role: 'assistant',
    source: 'transcript',
    blocks,
    timestamp: null
  }
  return createElement(MobileNativeChatMessage, { message })
}

const hostRead = (path: string) => [
  'files.readChatImage',
  { worktree: 'id:wt-1', path },
  expect.anything()
]
const thumbnails = (tree: ReactTestRenderer) =>
  findAllByHostType(tree.root, 'Image').map((image) => image.props.source.uri)

it('draws prose images from the web or the host, and leaves the rest as links', async () => {
  const tree = await renderWithHost(assistant([{ type: 'text', text: '![shot](/tmp/s.png)' }]))
  const { renderImage } = findByHostType(tree.root, 'MobileMarkdown').props
  const draw = (href: string) => renderWithHost(renderImage(href, 'shot'))

  for (const [href, path] of [
    ['/tmp/s.png', '/tmp/s.png'],
    ['file:///tmp/s%20b.png', '/tmp/s b.png'],
    ['C:/shots/s.png', 'C:/shots/s.png']
  ]) {
    const image = await draw(href!)
    expect(sendRequest).toHaveBeenCalledWith(...hostRead(path!))
    expect(thumbnails(image)).toEqual([`data:image/png;base64,${PNG}`])
  }
  for (const url of ['https://example.com/s.png', 'data:image/png;base64,AA']) {
    expect(thumbnails(await draw(url))).toEqual([url])
    expect(sendRequest).not.toHaveBeenCalled()
  }
  for (const kept of [
    'shots/s.png',
    'http://192.168.1.10:8000/s.png',
    'data:image/svg+xml;base64,AA',
    '/repo/logo.svg',
    'https://img.example/b.svg?v=1',
    '/repo/out/report.pdf'
  ]) {
    expect(renderImage(kept, 'shot')).toBeNull()
  }
})

it('shows the image a Read returned under the closed run', async () => {
  const tree = await renderWithHost(
    assistant([
      { type: 'tool-call', name: 'Read', callId: 'c1', input: { file_path: '/tmp/s2.png' } },
      { type: 'tool-result', callId: 'c1', output: '' }
    ])
  )
  expect(sendRequest).toHaveBeenCalledWith(...hostRead('/tmp/s2.png'))
  expect(thumbnails(tree)).toEqual([`data:image/png;base64,${PNG}`])
})
