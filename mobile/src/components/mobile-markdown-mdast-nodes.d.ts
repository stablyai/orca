import type { BlockContent, DefinitionContent, Literal, Parent, PhrasingContent } from 'mdast'

// The node types MobileMarkdown adds to mdast, registered by declaration merging. Merging needs
// interfaces, which React Doctor's root rules flag; mobile's lint config ignores this file because
// it turns that rule off and would report these disable comments as unused.

declare module 'mdast' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface Details extends Parent {
    type: 'details'
    /** Authored `open`: the section starts expanded. */
    open: boolean
    summary: PhrasingContent[]
    /** Its `</details>` came inside a paragraph, list or quote: it closes when that does. */
    closesWithContainer?: boolean
    children: (BlockContent | DefinitionContent)[]
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface InlineMath extends Literal {
    type: 'inlineMath'
    /** `$$` or `\[`: shown as a display formula when it stands alone in its paragraph. */
    display: boolean
    /** The authored text, delimiters included, for copying and fallbacks. */
    source: string
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface Math extends Literal {
    type: 'math'
    source: string
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface PhrasingContentMap {
    inlineMath: InlineMath
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface RootContentMap {
    details: Details
    inlineMath: InlineMath
    math: Math
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface BlockContentMap {
    details: Details
    math: Math
  }
}
