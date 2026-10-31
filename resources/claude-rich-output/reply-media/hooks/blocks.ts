// What `![alt](path)` plays rather than shows, told by the path's extension.
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|gif)$/i
// The kinds of block the mod draws: the `/config` switch of each, and the
// renderer script that draws it.
export const KINDS = [
  ['diagrams', 'render'],
  ['math', 'math'],
  ['images', 'picture'],
  ['videos', 'video']
] as const
export type Script = (typeof KINDS)[number][1]
// What Claude reads in its system prompt, so that it writes the blocks the mod
// draws: Claude writes none of them unprompted. A kind switched off is not
// told, so Claude does not write a block that would stay its source.
export function forms(drawn: ReadonlySet<Script>) {
  const isImage = drawn.has('picture')
  const isVideo = drawn.has('video')
  const notes = [
    drawn.has('render') && [
      'Diagrams:',
      '',
      'Draw diagrams in replies as ```mermaid code fences, never as ASCII art. The reply-media mod turns each fence into a picture in the terminal.',
      'Use only these types, the rest do not render: flowchart, stateDiagram-v2, sequenceDiagram, classDiagram, erDiagram, xychart-beta.',
      'Start the fence at column 0: an indented fence (inside a list item or a quote) is not picked up.',
      "Prefer flowchart LR: a TD chart with more than a few nodes fills the terminal's height.",
      'Directory trees and tables are not diagrams: keep them as text.'
    ],
    drawn.has('math') && [
      'Math:',
      '',
      'Write a formula that stands on a line of its own as LaTeX in a ```math code fence, one formula per fence, starting at column 0. The reply-media mod turns it into a picture. Leave out `\\tag`: a tagged formula is not drawn.',
      'Write math inside a sentence in Unicode (a⃗ · b⃗ = |a||b|cos θ), never as `$x$`: a picture cannot sit inside a line of text.'
    ],
    (isImage || isVideo) && [
      'Images:',
      '',
      isImage
        ? "To show an image file from this machine, write `![alt](path)` on a line of its own, starting at column 0. The reply-media mod draws it. The path is absolute, under `~/`, or relative to the session's working directory. An image at a URL is not fetched, so give its link as text."
        : "To show a video file from this machine (mp4, mov, webm, mkv, gif), write `![alt](path)` on a line of its own, starting at column 0. The reply-media mod shows its first frame with a play button. The path is absolute, under `~/`, or relative to the session's working directory.",
      ...(isImage && isVideo
        ? [
            'A video file (mp4, mov, webm, mkv, gif) written the same way is shown as its first frame with a play button.'
          ]
        : []),
      ...(isImage
        ? [
            'For a drawing mermaid cannot make (a UI sketch, a layout, an annotated picture), write an SVG file to the scratchpad and show it with the image form above.'
          ]
        : [])
    ]
  ].filter((note) => note !== false)

  return notes.length === 0 ? undefined : notes.map((note) => note.join('\n')).join('\n\n')
}

// A Button's key, from what it copies: a reply is drawn in parts when two mods
// draw it between them, so a count kept by one part would repeat in the next.
export const hash = (text: string) =>
  (
    [...text].reduce((sum, char) => (Math.imul(sum, 31) + char.charCodeAt(0)) | 0, 0) >>> 0
  ).toString(36)

const FENCE = /^([ \t]*)(`{3,}(?=[^`\n]*$)|~{3,})([^\n]*)$/
const FORMULA = /^\$\$[ \t\r]*$/
const IMAGE = /^!\[[^\]\n]*\]\([^)\n]+\)[ \t\r]*$/

const closesFence = (line: string, marker: string) => {
  const run = FENCE.exec(line)?.[2] ?? ''
  return run[0] === marker[0] && run.length >= marker.length && line.trim() === run
}

/** Alternating text and closed blocks; every fence shields its literal contents. */
export function splitBlocks(text: string): string[] {
  const parts: string[] = []
  const lines = text.split('\n')
  let position = 0
  let cursor = 0

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const opening = FENCE.exec(line)?.[2]
    let end = index
    if (opening !== undefined || FORMULA.test(line)) {
      end++
      while (
        end < lines.length &&
        !(opening === undefined
          ? FORMULA.test(lines[end] ?? '') || FENCE.test(lines[end] ?? '')
          : closesFence(lines[end] ?? '', opening))
      ) {
        end++
      }
      if (end === lines.length || (opening === undefined && !FORMULA.test(lines[end] ?? ''))) {
        if (opening !== undefined) {
          break
        }
        position += line.length + 1
        continue
      }
    } else if (!IMAGE.test(line)) {
      position += line.length + 1
      continue
    }

    const start = position
    for (let current = index; current <= end; current++) {
      position += (lines[current]?.length ?? 0) + 1
    }
    parts.push(text.slice(cursor, start), text.slice(start, position - 1))
    cursor = position - 1
    index = end
  }

  parts.push(text.slice(cursor))
  return parts
}

/**
 * The renderer script that draws a block and what that script reads, or
 * undefined for a block the mod leaves as text, its kind switched off too.
 */
export function classify(block: string, drawn: ReadonlySet<Script>) {
  const job = kindOf(block)

  return job !== undefined && drawn.has(job.script) ? job : undefined
}

function kindOf(block: string): { script: Script; source: string } | undefined {
  const firstBreak = block.indexOf('\n')
  const opening = FENCE.exec(block.slice(0, firstBreak))
  if (opening) {
    const [, indent = '', marker = '', info = ''] = opening
    const lastBreak = block.lastIndexOf('\n')
    if (
      indent !== '' ||
      marker !== '```' ||
      lastBreak <= firstBreak ||
      !closesFence(block.slice(lastBreak + 1), marker)
    ) {
      return undefined
    }
    // The whole name: a `mathematica` fence is code, not a formula.
    const [language] = info.trim().split(/\s+/)
    const script = language === 'mermaid' ? 'render' : language === 'math' ? 'math' : undefined

    return script === undefined
      ? undefined
      : { script, source: block.slice(firstBreak + 1, lastBreak) }
  }

  const formula = /^\$\$[ \t\r]*\n([\s\S]*)\n\$\$[ \t\r]*$/.exec(block)
  if (formula) {
    return { script: 'math', source: formula[1] ?? '' }
  }

  if (!IMAGE.test(block)) {
    return undefined
  }
  const path = /\]\(([^)\n]+)\)/.exec(block)?.[1]?.trim() ?? ''

  // A file on the network is not fetched: only one on this machine.
  return path === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
    ? undefined
    : { script: VIDEO.test(path) ? 'video' : 'picture', source: path }
}
