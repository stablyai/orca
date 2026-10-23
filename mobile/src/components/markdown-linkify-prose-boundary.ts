import type MarkdownIt from 'markdown-it'
import { findProseUrlEnd, splitAtProseUrlTerminators } from '../../../src/shared/prose-url-boundary'

type Linkify = MarkdownIt['linkify']

// Why: linkify-it lets non-ascii punctuation run on in a url path, so `…/1078）。` kept `）。`;
// matching only the text between prose punctuation lets linkify's own trim run on just the url.
export function endLinkifyUrlsAtProsePunctuation(linkify: Linkify): void {
  const match = linkify.match.bind(linkify)
  const matchAtStart = linkify.matchAtStart.bind(linkify)

  linkify.match = (text) => {
    const links: NonNullable<ReturnType<Linkify['match']>> = []
    let offset = 0
    splitAtProseUrlTerminators(text).forEach((piece, index) => {
      if (index % 2 === 0) {
        for (const link of match(piece) ?? []) {
          links.push({ ...link, index: link.index + offset, lastIndex: link.lastIndex + offset })
        }
      }
      offset += piece.length
    })
    return links
  }
  linkify.matchAtStart = (text) => {
    const end = findProseUrlEnd(text)
    return matchAtStart(end === -1 ? text : text.slice(0, end))
  }
}
