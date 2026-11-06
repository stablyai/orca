import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Why: walk the declared dependency chain; isolated installs don't hoist decode-named-character-reference next to remark-parse.
const fromMarkdownRequire = createRequire(
  createRequire(require.resolve('remark-parse')).resolve('mdast-util-from-markdown')
)
const mathRequire = createRequire(require.resolve('rehype-katex'))

// Both preview paths use DOM-free parsing so their dependencies also run in workers.
export const markdownParserAliases = {
  'decode-named-character-reference': fromMarkdownRequire.resolve(
    'decode-named-character-reference'
  ),
  'hast-util-from-html-isomorphic': mathRequire.resolve('hast-util-from-html-isomorphic')
}
