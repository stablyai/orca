import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { MobileMarkdown } from './MobileMarkdown'
import { MobileMarkdownLinksContext } from './mobile-markdown-links-context'
import { MarkdownInferredFileLinkHandlerContext } from './markdown-link-handler'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./pr-sidebar/MermaidDiagram', () => ({ MermaidDiagram: 'MermaidDiagram' }))
vi.mock('./MobileSourceCopyButton', () => ({ MobileSourceCopyButton: 'MobileSourceCopyButton' }))

it('offers workspace resolution only for inferred file taps, preserving explicit file opens', async () => {
  const offered: string[] = []
  const opened: string[] = []
  const snapshot = { check: () => true, peek: () => true }
  const fileLinks = {
    watch: () => ({ subscribe: () => () => {}, getSnapshot: () => snapshot }),
    recheck: () => {}
  }
  let tree: ReactTestRenderer | undefined
  try {
    await act(async () => {
      tree = create(
        <MarkdownInferredFileLinkHandlerContext value={(path) => offered.push(path)}>
          <MobileMarkdownLinksContext value={{ fileLinks, githubRepo: null }}>
            <MobileMarkdown
              content={
                '`~/.codex/AGENTS.md`, `AGENTS.md`, [AGENTS.md](AGENTS.md), ' +
                '`./AGENTS.md`, `C:\\repo\\AGENTS.md`, `report.html`'
              }
              onOpenFile={(path) => opened.push(path)}
            />
          </MobileMarkdownLinksContext>
        </MarkdownInferredFileLinkHandlerContext>
      )
    })
    act(() => {
      for (const link of tree!.root.findAll(
        (node) => String(node.type) === 'Text' && typeof node.props.onPress === 'function'
      )) {
        link.props.onPress()
      }
    })
    expect(offered).toEqual(['AGENTS.md', 'report.html'])
    expect(opened).toEqual([
      '~/.codex/AGENTS.md',
      'AGENTS.md',
      './AGENTS.md',
      'C:\\repo\\AGENTS.md'
    ])
  } finally {
    act(() => tree?.unmount())
  }
})
