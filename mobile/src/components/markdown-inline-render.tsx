import { Fragment, type ReactNode } from 'react'
import { createMarkdownInlineMatcher, type MarkdownInlineMatch } from './markdown-inline-matcher'
import { MarkdownInlineImage } from './markdown-image-view'
import { MarkdownText } from './markdown-text'
import { styles } from './mobile-markdown-styles'
import {
  detectFilePathSegments,
  isFilePathCodeSpan,
  normalizeFilePath
} from './markdown-file-path-detection'
import { openMarkdownHref, openMarkdownImage } from './markdown-href-routing'
import {
  isIntrawordUnderscoreToken,
  trimAutolinkTrailingPunctuation
} from './markdown-inline-token-rules'

// Render a plain (non-token) text run, splitting out tappable file paths when
// onOpenFile is provided. Without it, paths stay plain text.
function renderTextRun(
  text: string,
  keyPrefix: string,
  onOpenFile?: (pathText: string) => void
): ReactNode {
  if (!onOpenFile) {
    return text
  }
  const segments = detectFilePathSegments(text)
  if (segments.length === 1 && segments[0]!.type === 'text') {
    return text
  }
  return segments.map((segment, segmentIndex) => {
    if (segment.type === 'file') {
      return (
        <MarkdownText
          key={`${keyPrefix}:${segmentIndex}`}
          style={styles.link}
          onPress={() => onOpenFile(segment.path)}
        >
          {segment.value}
        </MarkdownText>
      )
    }
    return <Fragment key={`${keyPrefix}:${segmentIndex}`}>{segment.value}</Fragment>
  })
}

export function renderInline(
  text: string,
  onOpenFile?: (pathText: string) => void,
  imageSources?: Record<string, string>,
  onOpenImage?: (rawSrc: string) => void,
  imageScale = 1
): ReactNode[] {
  const parts: ReactNode[] = []
  const pattern = createMarkdownInlineMatcher(
    text,
    /(`[^`]+`|~~[^~]+~~|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<]+)/g,
    true
  )
  let pendingStart = 0
  let match: MarkdownInlineMatch | null

  while ((match = pattern.exec())) {
    const token = match[0]
    // Intraword `_` runs (snake_case, dunder tails) are literal text per
    // CommonMark; leaving them unflushed keeps surrounding file paths whole
    // for detection in the eventual text run.
    if (token.startsWith('_') && isIntrawordUnderscoreToken(text, match.index, token)) {
      // Resume after the opener so real tokens inside the rejected span are still scanned.
      pattern.lastIndex = match.index + 1
      continue
    }
    if (match.index > pendingStart) {
      parts.push(
        renderTextRun(text.slice(pendingStart, match.index), `t${pendingStart}`, onOpenFile)
      )
    }
    pendingStart = pattern.lastIndex
    const key = `${match.index}:${token}`
    const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (image) {
      const dataUri = imageSources?.[image[2]!]
      parts.push(
        dataUri ? (
          <MarkdownText
            key={key}
            onPress={() => openMarkdownImage(image[2]!, onOpenFile, onOpenImage)}
          >
            <MarkdownInlineImage uri={dataUri} alt={image[1] ?? ''} sizeScale={imageScale} />
          </MarkdownText>
        ) : (
          <MarkdownText
            key={key}
            style={styles.link}
            onPress={() => openMarkdownImage(image[2]!, onOpenFile, onOpenImage)}
          >
            {image[1] || 'image'}
          </MarkdownText>
        )
      )
    } else if (link) {
      parts.push(
        <MarkdownText
          key={key}
          style={styles.link}
          onPress={() => openMarkdownHref(link[2]!, onOpenFile)}
        >
          {link[1]}
        </MarkdownText>
      )
    } else if (/^https?:\/\//i.test(token)) {
      const { url, trailing } = trimAutolinkTrailingPunctuation(token)
      parts.push(
        <MarkdownText
          key={key}
          style={styles.link}
          onPress={() => openMarkdownHref(url, onOpenFile)}
        >
          {url}
        </MarkdownText>
      )
      if (trailing) {
        parts.push(<Fragment key={`${key}p`}>{trailing}</Fragment>)
      }
    } else if (token.startsWith('`')) {
      const code = token.slice(1, -1)
      if (onOpenFile && isFilePathCodeSpan(code)) {
        parts.push(
          <MarkdownText
            key={key}
            style={[styles.inlineCode, styles.inlineCodeLink]}
            onPress={() => onOpenFile(normalizeFilePath(code.trim()))}
          >
            {code}
          </MarkdownText>
        )
      } else {
        parts.push(
          <MarkdownText key={key} style={styles.inlineCode}>
            {code}
          </MarkdownText>
        )
      }
    } else if (token.startsWith('~~')) {
      parts.push(
        <MarkdownText key={key} style={styles.strike}>
          {renderTextRun(token.slice(2, -2), `${key}i`, onOpenFile)}
        </MarkdownText>
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      parts.push(
        <MarkdownText key={key} style={styles.bold}>
          {renderTextRun(token.slice(2, -2), `${key}i`, onOpenFile)}
        </MarkdownText>
      )
    } else {
      parts.push(
        <MarkdownText key={key} style={styles.italic}>
          {renderTextRun(token.slice(1, -1), `${key}i`, onOpenFile)}
        </MarkdownText>
      )
    }
  }

  if (pendingStart < text.length) {
    parts.push(renderTextRun(text.slice(pendingStart), `t${pendingStart}`, onOpenFile))
  }
  return parts
}
