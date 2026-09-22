export type MarkdownInlineMatch = { 0: string; index: number; end: number }

/** Merge a global non-link regex with links; search starts must advance between calls. */
export function createMarkdownInlineMatcher(
  text: string,
  nonLinkPattern: RegExp,
  images = false
): { lastIndex: number; exec: () => MarkdownInlineMatch | null } {
  let nextOther: MarkdownInlineMatch | null | undefined
  let nextLink: MarkdownInlineMatch | null | undefined
  let labelEnd = -1
  let destinationEnd = -1
  let noMoreLabels = false
  let noMoreDestinations = false

  function findLink(from: number): MarkdownInlineMatch | null {
    if (noMoreLabels || noMoreDestinations) {
      return null
    }
    let open = text.indexOf('[', from)
    while (open !== -1) {
      if (labelEnd < open + 1) {
        labelEnd = text.indexOf(']', open + 1)
      }
      if (labelEnd === -1) {
        noMoreLabels = true
        return null
      }
      const image = images && open > from && text[open - 1] === '!'
      if ((image || labelEnd > open + 1) && text[labelEnd + 1] === '(') {
        if (destinationEnd < labelEnd + 2) {
          destinationEnd = text.indexOf(')', labelEnd + 2)
        }
        if (destinationEnd === -1) {
          noMoreDestinations = true
          return null
        }
        if (destinationEnd > labelEnd + 2) {
          const index = image ? open - 1 : open
          return { 0: text.slice(index, destinationEnd + 1), index, end: destinationEnd + 1 }
        }
      }
      // Every opener before this closing bracket shares the same invalid suffix.
      open = text.indexOf('[', labelEnd + 1)
    }
    return null
  }

  const matcher = {
    lastIndex: 0,
    exec(): MarkdownInlineMatch | null {
      const from = matcher.lastIndex
      if (nextOther === undefined || (nextOther !== null && nextOther.index < from)) {
        nonLinkPattern.lastIndex = from
        const match = nonLinkPattern.exec(text)
        nextOther = match
          ? { 0: match[0], index: match.index, end: nonLinkPattern.lastIndex }
          : null
      }
      if (nextLink === undefined || (nextLink !== null && nextLink.index < from)) {
        nextLink = findLink(from)
      }
      const match =
        nextLink && (!nextOther || nextLink.index < nextOther.index) ? nextLink : nextOther
      if (match) {
        matcher.lastIndex = match.end
      }
      return match
    }
  }
  return matcher
}
