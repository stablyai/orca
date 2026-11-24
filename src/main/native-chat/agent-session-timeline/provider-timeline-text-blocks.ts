// List fences can open at any indentation; closers may be at most three spaces deeper.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/
// CommonMark blank lines contain only spaces and tabs.
const BLANK_LINE_PATTERN = /^[ \t]*$/
// Require trailing space so partial list markers cannot match during streaming.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/
// Unindented ATX headings end preceding paragraphs and lists without blank lines; bold lines do not.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/

/** Emit terminated lines only, except partial list-start lookahead for tight lists. Hold section titles until content follows. */
export function splitProviderTimelineTextBlocks(text: string): { ready: string; rest: string } {
  let openFence: { marker: string; indent: number } | null = null
  let boundary = -1
  let lineStart = 0
  let titleAwaitingContent = false
  for (;;) {
    const newline = text.indexOf('\n', lineStart)
    const line = text
      .slice(lineStart, newline === -1 ? text.length : newline)
      .replace(/[ \t\r]+$/, '')
    if (
      openFence === null &&
      lineStart > 0 &&
      !titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      boundary = lineStart
    }
    if (newline === -1) {
      break
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line)
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length
      const marker = fenceMatch[2]!
      if (openFence === null) {
        openFence = { marker, indent }
        titleAwaitingContent = false
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent - openFence.indent <= 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null
        boundary = newline + 1
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) {
        boundary = newline + 1
      }
    } else if (openFence === null) {
      if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
        boundary = lineStart
      }
      titleAwaitingContent = SECTION_TITLE_PATTERN.test(line)
    }
    lineStart = newline + 1
  }
  if (boundary === -1) {
    return { ready: '', rest: text }
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) }
}
