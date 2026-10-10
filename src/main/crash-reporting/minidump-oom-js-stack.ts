// Reduces the JS stack Electron records at a renderer's V8 heap limit to
// frames that name code but not the machine it ran on.
//
// Why: a renderer wedged in a synchronous allocation loop cannot run its own
// samplers, so this safe-point stack is the only evidence naming the loop.

export const ELECTRON_OOM_STACK_ANNOTATION = 'electron.v8-oom.stack'
export const ELECTRON_OOM_LOCATION_ANNOTATION = 'electron.v8-oom.location'
// V8's own key: `<fn> in <url>[:L:C]` lines. Electron's key holds only a heap
// summary ("(stack pending)") when the heap ran out before its interrupt ran.
export const V8_OOM_STACK_ANNOTATION = 'v8-oom-stack'

const MAX_FRAMES = 24
const MAX_FRAME_LENGTH = 160

const ELECTRON_FRAME_PATTERN = /^#\d+ /
const V8_FRAME_PATTERN = /^(.*?) in (.+)$/
const QUERY_PATTERN = /[?#].*?((?::\d+){0,2})$/

// Script locations embed the install dir (and so the OS user name); keep only
// the bundle basename and any line:col, which release source maps resolve.
// Why whole-span: preload frames are raw paths whose spaces are not escaped.
function sanitizeFrame(frame: string): string {
  const separator = frame.search(/[/\\]/)
  let sanitized = frame
  if (separator !== -1) {
    const open = frame.lastIndexOf('(', separator)
    const closed = open !== -1 && frame.endsWith(')')
    if (open !== -1 && !closed) {
      // A capped annotation cut this location short; its last segment may be the user name.
      return frame.slice(0, open).trimEnd()
    }
    const locationStart = open !== -1 ? open + 1 : frame.lastIndexOf(' ', separator) + 1
    const location = frame
      .slice(locationStart, closed ? -1 : undefined)
      .replace(QUERY_PATTERN, '$1')
    const basename = location.slice(
      Math.max(location.lastIndexOf('/'), location.lastIndexOf('\\')) + 1
    )
    sanitized = `${frame.slice(0, locationStart)}${basename}${closed ? ')' : ''}`
  }
  return sanitized.length > MAX_FRAME_LENGTH
    ? `${sanitized.slice(0, MAX_FRAME_LENGTH)}...`
    : sanitized
}

// Drops blanks and the one-character filler V8 writes after its frames.
function annotationLines(value: string | undefined): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 1)
}

// V8 caps its value at 1024 bytes and only writes the `$` filler when it fits,
// so without that filler the last line may end mid-path.
function v8FrameLines(value: string | undefined): string[] {
  const lines = annotationLines(value)
  return /\n\$\s*$/.test(value ?? '') ? lines : lines.slice(0, -1)
}

export function sanitizeOomJsStack(
  annotations: Readonly<Record<string, string>>
): string | undefined {
  const electronLines = annotationLines(annotations[ELECTRON_OOM_STACK_ANNOTATION])
  const lines = electronLines.some((line) => ELECTRON_FRAME_PATTERN.test(line))
    ? electronLines
    : [
        ...electronLines,
        ...v8FrameLines(annotations[V8_OOM_STACK_ANNOTATION]).map((line) => {
          const match = V8_FRAME_PATTERN.exec(line)
          return match ? `${match[1]} (${match[2]})` : line
        })
      ]
  const frames = lines.slice(0, MAX_FRAMES).map(sanitizeFrame)
  return frames.length > 0 ? frames.join('\n') : undefined
}
