import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { bareGitHubReferenceRepoForChat } from '../../../../src/shared/github/github-reference-links'
import { MobileMarkdown } from '../../components/MobileMarkdown'
import { mobileMarkdownDrawnCodeLines } from '../../components/mobile-markdown-drawn-code-lines'
import {
  MobileMarkdownLinksContext,
  type MobileMarkdownLinks
} from '../../components/mobile-markdown-links-context'
import type { RpcOperationSender } from '../../transport/rpc-operation-sender'
import type { RpcResponse } from '../../transport/types'
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
  const sendRequest = vi.fn(async (_method: string, params?: unknown): Promise<RpcResponse> => {
    const { relativePaths } = z.object({ relativePaths: z.array(z.string()) }).parse(params)
    return {
      id: '1',
      ok: true,
      result: relativePaths.map((path) => ({ exists: path === 'src/app.ts' })),
      _meta: { runtimeId: 'runtime-1' }
    }
  })
  const client: RpcOperationSender = { sendRequest }
  const fileLinks = createMobileNativeChatFileLinkExistence(client, 'repo-1::/work', '/work')
  const onOpenFile = vi.fn()

  const tree = await renderChat(
    'Edited src/app.ts:12 and src/gone.ts, plus `/work/src/app.ts`. Log at /tmp/run.json now, then call /api/users endpoint.',
    { fileLinks, githubRepo: null },
    onOpenFile
  )

  expect(sendRequest).toHaveBeenCalledTimes(1)
  expect(sendRequest.mock.calls[0]?.[0]).toBe('files.pathsExist')
  expect(sendRequest.mock.calls[0]?.[1]).toEqual({
    worktree: 'id:repo-1::/work',
    relativePaths: ['src/app.ts', 'src/gone.ts']
  })
  expect(linked(tree).map(label)).toEqual(['src/app.ts:12', '/work/src/app.ts', '/tmp/run.json'])
  act(() => linked(tree)[0]?.props.onPress())
  expect(onOpenFile).toHaveBeenCalledWith('src/app.ts:12')
})

it('only yields bare refs to a named repo in chat, not on PR surfaces', async () => {
  const content = 'Fixes #12, unlike vercel/next.js#42.'
  const githubRepo = { owner: 'stablyai', repo: 'orca' }

  const prTree = await renderChat(content, { fileLinks: null, githubRepo })
  expect(linked(prTree).map(label)).toEqual(['#12', 'vercel/next.js#42'])
  act(() => renderer?.unmount())

  const chatTree = await renderChat(content, {
    fileLinks: null,
    githubRepo,
    chatGitHubReferences: true
  })
  expect(linked(chatTree).map(label)).toEqual(['vercel/next.js#42'])
})

it.each([
  '```json\n{ "url": "https://github.com/other/repo" }\n```\n\nFixes #42.',
  '> ```text\n> https://github.com/other/repo\n> ```\n\nFixes #42.',
  '- ```text\n  other/repo#3\n\n  https://github.com/other/repo\n  ```\n\nFixes #42.',
  'Fixes #42.\n\n    https://github.com/other/repo',
  '<div>\n```text\nhttps://github.com/other/repo\n```\n</div>\n\nFixes #42.'
])('keeps the workspace repo when another repo is only in code: %j', async (content) => {
  const tree = await renderChat(content, {
    fileLinks: null,
    githubRepo: { owner: 'stablyai', repo: 'orca' },
    chatGitHubReferences: true
  })
  expect(linked(tree).map(label)).toEqual(['#42'])
})

it('keeps the workspace repo when another repo is only in code inside <details>', () => {
  const githubRepo = { owner: 'stablyai', repo: 'orca' }
  const content =
    '<details>\n<summary>Example</summary>\n```text\nhttps://github.com/other/repo\n```\n</details>\n\nFixes #42.'
  expect(bareGitHubReferenceRepoForChat(content, githubRepo, mobileMarkdownDrawnCodeLines)).toBe(
    githubRepo
  )
})

it('yields when a line in an HTML block is both prose and code', () => {
  const content =
    '<div>\nhttps://github.com/other/repo/pull/42\n```text\nhttps://github.com/other/repo/pull/42\n```\n</div>\n\nFixes #42.'
  expect(
    bareGitHubReferenceRepoForChat(
      content,
      { owner: 'stablyai', repo: 'orca' },
      mobileMarkdownDrawnCodeLines
    )
  ).toBeNull()
})

it.each([
  '```\nclosed\n```\nSee other/repo#3 and #42.',
  '- ```sh\n  echo hello\n  ```\n\nSee other/repo#3 and #42.',
  '> ```sh\n> echo hello\n\nSee other/repo#3 and #42.',
  '- Example:\n\n  ```sh\n  echo hello\n\nSee other/repo#3 and #42.',
  '```markdown\n> ```js\n> echo hello\n> ```\n```\n\nSee other/repo#3 and #42.',
  '<div>\nSee other/repo#3 and #42.\n</div>',
  'See `other/repo#3` and #42.'
])('yields when another repo is outside code blocks: %j', async (content) => {
  const tree = await renderChat(content, {
    fileLinks: null,
    githubRepo: { owner: 'stablyai', repo: 'orca' },
    chatGitHubReferences: true
  })
  expect(linked(tree).map(label)).toEqual(
    content.includes('`other/repo#3`') ? [] : ['other/repo#3']
  )
})
