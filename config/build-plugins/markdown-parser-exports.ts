import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const parserRequire = createRequire(require.resolve('remark-parse'))
const mathRequire = createRequire(require.resolve('rehype-katex'))

// Both preview paths use DOM-free parsing so their dependencies also run in workers.
export const markdownParserAliases = {
  'decode-named-character-reference': parserRequire.resolve('decode-named-character-reference'),
  'hast-util-from-html-isomorphic': mathRequire.resolve('hast-util-from-html-isomorphic')
}
