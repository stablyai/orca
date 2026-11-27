import { createPatch, formatPatch, structuredPatch } from 'diff'
import { replacementPatch } from './provider-timeline-replacement-patch'

const PATCH_CONTEXT_LINES = 4
// Shared lines kept past the context help jsdiff align repeated lines close to how it would on the
// whole file; trailing context can still come out one line shorter.
const SPAN_PADDING_LINES = 8
// The diff runs on the main process: whole texts up to this size, above it only the changed span.
const FULL_DIFF_TEXT_LIMIT = 256 * 1024
const FULL_DIFF_EDIT_LIMIT = 1024
const SPAN_TEXT_LIMIT = 64 * 1024
const SPAN_EDIT_LIMIT = 256
const SCAN_CHUNK = 4096

/** Chunked compare: a char loop over a multi-MB file costs more than the diff it trims. */
function sharedLength(limit: number, same: (from: number, to: number) => boolean): number {
  let length = 0
  let chunk = SCAN_CHUNK
  while (length < limit) {
    const to = Math.min(length + chunk, limit)
    if (same(length, to)) {
      length = to
    } else if (chunk === 1) {
      break
    } else {
      chunk = Math.max(1, chunk >> 3)
    }
  }
  return length
}

const lineStart = (text: string, index: number): number =>
  index <= 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1

const lineEnd = (text: string, index: number): number =>
  text.indexOf('\n', index) + 1 || text.length

function linesBefore(text: string, index: number): number {
  let count = 0
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) {
    count += 1
  }
  return count
}

/** Patch for an edit: the full diff of small texts, otherwise only the lines between shared ends. */
export function boundedPatch(path: string, oldText: string, newText: string): string {
  if (oldText.length + newText.length <= FULL_DIFF_TEXT_LIMIT) {
    return (
      createPatch(path, oldText, newText, undefined, undefined, {
        maxEditLength: FULL_DIFF_EDIT_LIMIT
      }) ?? replacementPatch(path, oldText, newText)
    )
  }
  const shortest = Math.min(oldText.length, newText.length)
  const head = sharedLength(
    shortest,
    (from, to) => oldText.slice(from, to) === newText.slice(from, to)
  )
  const changedStart = lineStart(oldText, head)
  const tail = sharedLength(
    shortest - changedStart,
    (from, to) =>
      oldText.slice(oldText.length - to, oldText.length - from) ===
      newText.slice(newText.length - to, newText.length - from)
  )
  const newIndex = (oldIndex: number): number => newText.length - (oldText.length - oldIndex)
  const tailStart = oldText.length - tail
  // A shared tail that starts a line in both texts leaves that line out of the change.
  const changedEnd =
    lineStart(oldText, tailStart) === tailStart &&
    lineStart(newText, newIndex(tailStart)) === newIndex(tailStart)
      ? tailStart
      : lineEnd(oldText, tailStart)
  let start = changedStart
  let end = changedEnd
  for (let line = 0; line < PATCH_CONTEXT_LINES + SPAN_PADDING_LINES; line++) {
    start = lineStart(oldText, start - 1)
    end = lineEnd(oldText, end)
  }
  const newEnd = newIndex(end)
  const patch =
    end - start + (newEnd - start) <= SPAN_TEXT_LIMIT
      ? structuredPatch(
          path,
          path,
          oldText.slice(start, end),
          newText.slice(start, newEnd),
          undefined,
          undefined,
          {
            context: PATCH_CONTEXT_LINES,
            maxEditLength: SPAN_EDIT_LIMIT
          }
        )
      : undefined
  if (!patch) {
    return replacementPatch(
      path,
      oldText.slice(changedStart, changedEnd),
      newText.slice(changedStart, newIndex(changedEnd)),
      linesBefore(oldText, changedStart)
    )
  }
  const skippedLines = linesBefore(oldText, start)
  for (const hunk of patch.hunks) {
    hunk.oldStart += skippedLines
    hunk.newStart += skippedLines
  }
  return formatPatch(patch)
}
