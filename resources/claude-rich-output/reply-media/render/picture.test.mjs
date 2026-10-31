import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// One 12 x 8 picture in three formats, made here rather than committed. The
// real path, since that is what a relative path resolves against.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'picture-test-')))
after(() => rmSync(dir, { recursive: true }))
writeFileSync(join(dir, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"/>')
spawnSync('rsvg-convert', ['--output', join(dir, 'a.png'), join(dir, 'a.svg')])
const made = spawnSync('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-i',
  join(dir, 'a.png'),
  '-frames:v',
  '1',
  '-threads',
  '1',
  join(dir, 'a.jpg')
])
assert.equal(made.status, 0, String(made.stderr))
// Preserve the transparent 12x8 input without requiring a host WebP encoder.
writeFileSync(
  join(dir, 'space # image.webp'),
  Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvC8ABEAcQERGIiP4HAA==', 'base64')
)

const picture = (path) =>
  spawnSync('node', [join(import.meta.dirname, 'picture.mjs')], {
    input: path,
    cwd: dir,
    encoding: 'utf8'
  })

test('picture passes a PNG through as it is', () => {
  const line = JSON.parse(picture(' a.png\n').stdout)

  assert.deepEqual(line, {
    file: join(dir, 'a.png'),
    width: 12,
    height: 8,
    path: join(dir, 'a.png')
  })
})

// A JPEG becomes a PNG of its own pixels; an SVG, having none, one three
// times as fine, its size still said in the SVG's px.
for (const [name, zoom] of [
  ['a.jpg', 1],
  ['space # image.webp', 1],
  ['a.svg', 3]
]) {
  test(`picture draws ${name} as a PNG, ${zoom} px to each of its own`, () => {
    const { file, width, height } = JSON.parse(picture(join(dir, name)).stdout)
    const png = readFileSync(file)
    rmSync(file)

    assert.notEqual(file, join(dir, name))
    assert.equal(png.toString('latin1', 1, 4), 'PNG')
    assert.deepEqual([width, height], [12, 8])
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [12 * zoom, 8 * zoom])
  })
}

test('picture fails on a missing file, with nothing on stdout', () => {
  const run = picture('missing.png')

  assert.notEqual(run.status, 0)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /ENOENT/)
})
