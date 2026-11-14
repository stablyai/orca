import type { Image, PhrasingContent } from 'mdast'
import { Fragment, type ReactNode } from 'react'
import { View } from 'react-native'
import { MarkdownText } from './mobile-markdown-text'
import { renderInline } from './mobile-markdown-inline'
import { styles } from './mobile-markdown-styles'
import type { MarkdownBlockContext, ParagraphText } from './mobile-markdown-blocks'

function isBlankInline(node: PhrasingContent): boolean {
  return node.type === 'break' || (node.type === 'text' && node.value.trim() === '')
}

/** Images draw as blocks between the paragraph's text runs; an image `renderImage` declines stays a link. */
export function renderImageParagraph(
  children: PhrasingContent[],
  images: readonly Image[],
  key: number,
  ctx: MarkdownBlockContext,
  text: ParagraphText
): ReactNode {
  const { renderImage } = ctx
  if (!renderImage || images.length === 0) {
    return null
  }
  const eligibleImages = new Set(images)
  const parts: ReactNode[] = []
  let drewImage = false
  let run: PhrasingContent[] = []
  const flushRun = (): void => {
    if (!run.every(isBlankInline)) {
      parts.push(
        <MarkdownText key={parts.length} selectable={text.selectable} style={text.style}>
          {renderInline(trimRunEdges(run), ctx)}
        </MarkdownText>
      )
    }
    run = []
  }
  for (const child of children) {
    const image =
      child.type === 'image' && eligibleImages.has(child)
        ? renderImage(child.url, child.alt ?? '', child.data?.width)
        : null
    if (image === null || image === undefined) {
      run.push(child)
      continue
    }
    flushRun()
    parts.push(<Fragment key={parts.length}>{image}</Fragment>)
    drewImage = true
  }
  if (!drewImage) {
    return null
  }
  flushRun()
  // One wrapper whatever the part count, so a growing paragraph never remounts its images.
  return (
    <View key={key} style={styles.imageParagraph}>
      {parts}
    </View>
  )
}

// The line breaks beside an image would otherwise leave blank lines in the text around it.
function trimRunEdges(run: PhrasingContent[]): PhrasingContent[] {
  let start = 0
  let end = run.length
  while (start < end && run[start]?.type === 'break') {
    start += 1
  }
  while (end > start && run[end - 1]?.type === 'break') {
    end -= 1
  }
  const trimmed = run.slice(start, end)
  const first = trimmed[0]
  if (first?.type === 'text') {
    trimmed[0] = { ...first, value: first.value.trimStart() }
  }
  const last = trimmed.at(-1)
  if (last?.type === 'text') {
    trimmed[trimmed.length - 1] = { ...last, value: last.value.trimEnd() }
  }
  return trimmed
}
