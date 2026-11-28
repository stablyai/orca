import type { Image, PhrasingContent, Root, RootContent } from 'mdast'

/** The same nesting boundary applies to native layout and image discovery. */
export function mobileMarkdownBlockIsLiteral(node: RootContent, depth: number): boolean {
  return depth > 8 && 'children' in node
}

export function mobileMarkdownParagraphImage(
  node: PhrasingContent,
  documentImages: boolean
): Image | undefined {
  if (documentImages && node.type === 'link') {
    const children = node.children.filter(
      (child) => child.type !== 'text' || child.value.trim() !== ''
    )
    const image = children[0]
    return image?.type === 'image' && children.length === 1 ? image : undefined
  }
  return node.type === 'image' ? node : undefined
}

export function mobileMarkdownParagraphImages(
  node: RootContent,
  depth: number,
  documentImages = false
): Image[] {
  return node.type === 'paragraph' && !mobileMarkdownBlockIsLiteral(node, depth)
    ? node.children.flatMap((child) => mobileMarkdownParagraphImage(child, documentImages) ?? [])
    : []
}

/** Only block containers recurse into image-bearing paragraphs; inline content stays links. */
export function mobileMarkdownNestedBlocks(
  node: RootContent,
  depth: number
): { nodes: readonly RootContent[]; depth: number }[] {
  if (mobileMarkdownBlockIsLiteral(node, depth)) {
    return []
  }
  switch (node.type) {
    case 'blockquote':
    case 'details':
    case 'footnoteDefinition':
      return [{ nodes: node.children, depth: depth + 1 }]
    case 'list':
      return node.children.map((item) => ({ nodes: item.children, depth: depth + 1 }))
    default:
      return []
  }
}

export function mobileMarkdownImageSources(
  root: Root,
  accepts: (href: string) => boolean
): string[] {
  const sources: string[] = []
  function collect(nodes: readonly RootContent[], depth: number): void {
    for (const node of nodes) {
      for (const image of mobileMarkdownParagraphImages(node, depth)) {
        if (accepts(image.url)) {
          sources.push(image.url)
        }
      }
      for (const nested of mobileMarkdownNestedBlocks(node, depth)) {
        collect(nested.nodes, nested.depth)
      }
    }
  }
  collect(root.children, 0)
  return sources
}
