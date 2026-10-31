import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// One second of a 64 x 48 test pattern, made here rather than committed. The
// real path, since that is what a relative path resolves against.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'video-test-')))
const made = []
after(() => [dir, ...made].forEach((folder) => rmSync(folder, { recursive: true, force: true })))
spawnSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc=duration=1:size=64x48:rate=10',
  join(dir, 'a.mp4')
])

const video = (path, ...args) =>
  spawnSync('node', [join(import.meta.dirname, 'video.mjs'), ...args], {
    input: path,
    cwd: dir,
    encoding: 'utf8'
  })

test('video draws the first frame of a clip, and says where the clip is', () => {
  const { file, width, height, clip } = JSON.parse(video(' a.mp4\n').stdout)
  made.push(join(file, '..'))

  assert.equal(readFileSync(file).toString('latin1', 1, 4), 'PNG')
  assert.deepEqual([width, height], [64, 48])
  assert.equal(clip, join(dir, 'a.mp4'))
})

test('video cuts a clip into frames once, and again when its end is gone', () => {
  const frames = JSON.parse(video('a.mp4', 'frames').stdout)
  const last = join(frames.dir, `f${String(frames.count).padStart(5, '0')}.png`)

  // One second at the top rate.
  assert.deepEqual([frames.count, frames.fps], [12, 12])
  assert.ok(existsSync(last))

  rmSync(last)
  assert.deepEqual(JSON.parse(video('a.mp4', 'frames').stdout), frames)
  assert.ok(existsSync(last))
})

test('video fails on a missing file, with nothing on stdout', () => {
  const run = video('missing.mp4')

  assert.notEqual(run.status, 0)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /ENOENT/)
})
