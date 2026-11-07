import { describe, expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

describe('rich Markdown Find routing', () => {
  const spec = 'tests/e2e/markdown-find-adversarial.spec.ts'

  it.each([
    'src/renderer/src/components/editor/rich-markdown/search/rich-markdown-search-focus.ts',
    'src/renderer/src/components/editor/rich-markdown/search/RichMarkdownSearchBar.tsx',
    'src/renderer/src/components/editor/rich-markdown/instance/RichMarkdownEditorSurface.tsx'
  ])('routes %s', (file) => {
    expect(selectPrE2eSpecs([file])).toContain(spec)
  })

  it.each([
    'src/renderer/src/components/editor/rich-markdown/search/rich-markdown-search-focus.test.ts',
    'src/renderer/src/components/editor/rich-markdown/instance/RichMarkdownEditor.tsx'
  ])('does not route %s', (file) => {
    expect(selectPrE2eSpecs([file])).not.toContain(spec)
  })
})
