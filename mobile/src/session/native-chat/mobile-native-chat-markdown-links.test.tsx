import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileMarkdown } from '../../components/MobileMarkdown'
import {
  MobileMarkdownLinksContext,
  type MobileMarkdownLinks
} from '../../components/mobile-markdown-links-context'
import type { RpcClient } from '../../transport/rpc-client'
import { createMobileNativeChatFileLinkExistence } from './use-mobile-native-chat-markdown-links'

const openURL = vi.fn((_url: string) => Promise.resolve())

vi.mock('react-native', () => ({
  Linking: { openURL: (url: string) => openURL(url) },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../../components/pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))
vi.mock('../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'MobileSourceCopyButton'
}))

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  openURL.mockClear()
})

function linked(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll(
    (node) => String(node.type) === 'Text' && typeof node.props.onPress === 'function'
  )
}

const label = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : label(child))).join('')

async function renderChat(content: string, links: MobileMarkdownLinks, onOpenFile = vi.fn()) {
  await act(async () => {
    renderer = create(
      createElement(
        MobileMarkdownLinksContext.Provider,
        { value: links },
        createElement(MobileMarkdown, { content, onOpenFile })
      )
    )
  })
  // Let the batched host answer land and the message re-render.
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      await Promise.resolve()
    }
  })
  return renderer!
}

it('links only workspace paths the host confirms, asking once for the whole reply', async () => {
  const sendRequest = vi.fn(async (_method: string, params: { relativePaths: string[] }) => ({
    id: '1',
    ok: true,
    result: params.relativePaths.map((path) => ({ exists: path === 'src/app.ts' })),
    _meta: { runtimeId: 'runtime-1' }
  }))
  const client = { sendRequest } as unknown as RpcClient
  const fileLinks = createMobileNativeChatFileLinkExistence(client, 'repo-1::/work', '/work')
  const onOpenFile = vi.fn()

  const tree = await renderChat(
    'Edited src/app.ts:12 and src/gone.ts, plus `/work/src/app.ts`. Log at /tmp/run.log.',
    { fileLinks, githubRepo: null },
    onOpenFile
  )

  expect(sendRequest).toHaveBeenCalledTimes(1)
  expect(sendRequest.mock.calls[0]?.[0]).toBe('files.pathsExist')
  expect(sendRequest.mock.calls[0]?.[1]).toEqual({
    worktree: 'id:repo-1::/work',
    relativePaths: ['src/app.ts', 'src/gone.ts']
  })
  expect(linked(tree).map(label)).toEqual(['src/app.ts:12', '/work/src/app.ts', '/tmp/run.log'])
  act(() => linked(tree)[0]?.props.onPress())
  expect(onOpenFile).toHaveBeenCalledWith('src/app.ts:12')
})

it('opens a bare #123 on the repo bare refs point to, leaving embedded ones alone', async () => {
  const tree = await renderChat('Fixed in #123, see stablyai/other#7 and issue#9.', {
    fileLinks: null,
    githubRepo: { owner: 'stablyai', repo: 'orca' }
  })

  expect(linked(tree).map(label)).toEqual(['#123', 'stablyai/other#7'])
  act(() => linked(tree)[0]?.props.onPress())
  expect(openURL).toHaveBeenCalledWith('https://github.com/stablyai/orca/issues/123')
})
