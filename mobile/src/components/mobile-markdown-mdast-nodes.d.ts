import type { BlockContent, DefinitionContent, Parent, PhrasingContent } from 'mdast'

// The node types MobileMarkdown adds to mdast, registered by declaration merging.

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
  interface RootContentMap {
    details: Details
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface BlockContentMap {
    details: Details
  }
}
