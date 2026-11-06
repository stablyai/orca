import type { BlockContent, DefinitionContent, Literal, Parent, PhrasingContent } from 'mdast'
import type { GitHubCalloutKind } from '../../../src/shared/github/github-callouts'

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
  interface HtmlSpan extends Parent {
    /** An inline HTML tag GitHub allows that mdast has no node for. */
    type: 'htmlSpan'
    tag: string
    children: PhrasingContent[]
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface PhrasingContentMap {
    inlineMath: InlineMath
    htmlSpan: HtmlSpan
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface RootContentMap {
    details: Details
    htmlSpan: HtmlSpan
    inlineMath: InlineMath
    math: Math
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface BlockContentMap {
    details: Details
    math: Math
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface BlockquoteData {
    /** A GitHub alert (`> [!NOTE]`): drawn with its kind's colour, icon and title. */
    callout?: GitHubCalloutKind
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface ImageData {
    /** An HTML `<img width>`: the width GitHub draws it at. */
    width?: number
  }
}
