// Usage: node picture.mjs < path.txt
// Prints {"file","width","height","path"} for the image file at a path:
// absolute, under ~/ or relative to the working directory; "path" is it made
// absolute. A PNG is used as it is; any
// other is drawn as the private per-user cache/<sha1>.png, by `sips` (macOS)
// or `ffmpeg` (Linux)
// or, for an SVG, `rsvg-convert` (brew install librsvg). The size is in the
// picture's own px: the PNG's, or the SVG's.
import { runRendererProcess as spawnSync } from './process.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { mediaCacheDirectory, pruneMediaCache } from './media-cache-directory.mjs'
import { readPngCacheEntry } from './png-cache-entry.mjs'
import { dirname, join, resolve } from 'node:path'

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
  const isSvg = /\.svgz?$/i.test(path)
  zoom = isSvg ? ZOOM : 1
  // Named by path, mtime and zoom, so an edited file is drawn again, and so
  // is every SVG once the zoom changes.
  const name = createHash('sha1').update(`${path}${stat.mtimeMs}@${zoom}`).digest('hex')
  const dir = mediaCacheDirectory(`${name}.png`)
  file = join(dir, `${name}.png`)
  if (!readPngCacheEntry(file)) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.png`
    try {
      const png = isSvg
        ? spawnSync('rsvg-convert', ['--zoom', String(zoom), '--output', temporary, path])
        : process.platform === 'darwin'
          ? spawnSync('sips', ['-s', 'format', 'png', path, '--out', temporary])
          : spawnSync('ffmpeg', [
              '-v',
              'error',
              '-y',
              '-protocol_whitelist',
              'file',
              '-i',
              path,
              '-frames:v',
              '1',
              '-threads',
              '1',
              temporary
            ])
      if (png.status !== 0) {
        throw new Error(String(png.stderr || png.error))
      }
      if (!readPngCacheEntry(temporary)) {
        throw new Error('conversion did not produce a complete PNG')
      }
      renameSync(temporary, file)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

const size = readPngCacheEntry(file)
if (!size) {
  throw new Error(`not a complete PNG: ${path}`)
}
if (file !== path) {
  pruneMediaCache(dirname(file), file)
}
console.log(
  JSON.stringify({
    file,
    width: size.width / zoom,
    height: size.height / zoom,
    path
  })
)
