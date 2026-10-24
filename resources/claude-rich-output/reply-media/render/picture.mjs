// Usage: node picture.mjs < path.txt
// Prints {"file","width","height","path"} for the image file at a path:
// absolute, under ~/ or relative to the working directory; "path" is it made
// absolute. A PNG is used as it is; any
// other is drawn as <tmp>/claude-reply-media/<sha1>.png, by `sips` (macOS)
// or `ffmpeg` (Linux)
// or, for an SVG, `rsvg-convert` (brew install librsvg). The size is in the
// picture's own px: the PNG's, or the SVG's.
import { runRendererProcess as spawnSync } from './process.mjs'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// An SVG is drawn this many PNG px to each px of its own, as render.mjs draws
// a diagram, so that it stays sharp when shown at its own size. Not imported
// from there: showing a picture would then load the mermaid renderer.
const ZOOM = 3

/** The start of a PNG: its signature, then the chunk that holds its size. */
function header(file) {
  const bytes = Buffer.alloc(24)
  const fd = openSync(file)
  readSync(fd, bytes)
  closeSync(fd)
  return bytes
}

// A URL resolves to a path that does not exist, and fails as one.
const path = resolve(
  readFileSync(0, 'utf8')
    .trim()
    .replace(/^~(?=\/)/, homedir())
)
const stat = statSync(path)
if (!stat.isFile()) {
  throw new Error(`not a regular file: ${path}`)
}

let file = path
let zoom = 1
// Told by its signature, not its extension: the terminal reads `file` as a
// PNG whatever it is called.
if (header(path).toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') {
  const dir = join(tmpdir(), 'claude-reply-media')
  mkdirSync(dir, { recursive: true })
  const isSvg = /\.svgz?$/i.test(path)
  zoom = isSvg ? ZOOM : 1
  // Named by path, mtime and zoom, so an edited file is drawn again, and so
  // is every SVG once the zoom changes.
  const name = createHash('sha1').update(`${path}${stat.mtimeMs}@${zoom}`).digest('hex')
  file = join(dir, `${name}.png`)
  const png = isSvg
    ? spawnSync('rsvg-convert', ['--zoom', String(zoom), '--output', file, path])
    : process.platform === 'darwin'
      ? spawnSync('sips', ['-s', 'format', 'png', path, '--out', file])
      : spawnSync('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-i',
          path,
          '-frames:v',
          '1',
          '-threads',
          '1',
          file
        ])
  if (png.status !== 0) {
    throw new Error(String(png.stderr || png.error))
  }
}

const ihdr = header(file)
console.log(
  JSON.stringify({
    file,
    width: ihdr.readUInt32BE(16) / zoom,
    height: ihdr.readUInt32BE(20) / zoom,
    path
  })
)
