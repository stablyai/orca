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

// What a reply holds on lines of its own that may become a picture: a code
// fence, a `$$` formula, an image. Every fence is matched, drawn or not, so
// that an example of a formula or an image inside one is left alone. One
// capture group, so String.split alternates text, block, text, ...
// ponytail: fences of exactly three backticks; a longer fence that holds a
// shorter one is cut at the inner close and stays text. Count the ticks if
// nested fences start to matter.
export const BLOCK =
  /^(```[^\n]*\n[\s\S]*?\n```[ \t]*|\$\$[ \t]*\n[\s\S]*?\n\$\$[ \t]*|!\[[^\]\n]*\]\([^)\n]+\)[ \t]*)$/gm

/**
 * The renderer script that draws a block and what that script reads, or
 * undefined for a block the mod leaves as text, its kind switched off too.
 */
export function classify(block: string, drawn: ReadonlySet<Script>) {
  const job = kindOf(block)

  return job !== undefined && drawn.has(job.script) ? job : undefined
}

function kindOf(block: string): { script: Script; source: string } | undefined {
  const fence = /^```([^\n]*)\n([\s\S]*)\n```[ \t]*$/.exec(block)
  if (fence) {
    const [, info = '', source = ''] = fence
    // The whole name: a `mathematica` fence is code, not a formula.
    const [language] = info.trim().split(/\s+/)
    const script = language === 'mermaid' ? 'render' : language === 'math' ? 'math' : undefined

    return script === undefined ? undefined : { script, source }
  }

  const formula = /^\$\$[ \t]*\n([\s\S]*)\n\$\$[ \t]*$/.exec(block)
  if (formula) {
    return { script: 'math', source: formula[1] ?? '' }
  }

  const path = /\]\(([^)\n]+)\)/.exec(block)?.[1]?.trim() ?? ''

  // A file on the network is not fetched: only one on this machine.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
    ? undefined
    : { script: VIDEO.test(path) ? 'video' : 'picture', source: path }
}
