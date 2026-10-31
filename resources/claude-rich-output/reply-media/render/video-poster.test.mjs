import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'video-poster-test-')))
after(() => rmSync(root, { recursive: true, force: true }))
const clip = join(root, 'clip.mp4')
const made = spawnSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc=duration=1:size=64x48:rate=10',
  clip
])
assert.equal(made.status, 0, made.stderr?.toString())

function fixture() {
  const cache = mkdtempSync(join(root, 'cache-'))
  const invoke = (mode = 'poster', preload) =>
    spawnSync(
      process.execPath,
      [
        ...(preload ? ['--require', preload] : []),
        join(import.meta.dirname, 'video.mjs'),
        ...(mode === 'frames' ? ['frames'] : [])
      ],
      {
        input: clip,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: cache, TMP: cache, TEMP: cache, LOCALAPPDATA: cache }
      }
    )
  const value = (mode, preload) => {
    const result = invoke(mode, preload)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const interrupt = () => {
    const file = join(cache, 'interrupt.cjs')
    writeFileSync(
      file,
      `
const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, ...rest) {
  if (command === 'ffmpeg') {
    const target = args.at(-1).replace('%05d', '00001');
    fs.writeFileSync(target, Buffer.alloc(24));
    return { status: 1, stderr: 'simulated interrupted video extraction' };
  }
  return original(command, args, ...rest);
};
require('node:module').syncBuiltinESMExports();
`
    )
    return file
  }
  return { cache, invoke, value, interrupt }
}

for (const [name, breakPng] of [
  ['truncated header', () => Buffer.alloc(24)],
  ['missing IEND', (bytes) => bytes.subarray(0, -12)],
  [
    'invalid signature',
    (bytes) => {
      bytes[0] = 0
      return bytes
    }
  ],
  [
    'zero dimensions',
    (bytes) => {
      bytes.writeUInt32BE(0, 16)
      return bytes
    }
  ]
]) {
  test(`an unchanged clip regenerates its ${String(name)} poster`, () => {
    const f = fixture()
    const first = f.value()
    const complete = readFileSync(first.file)
    writeFileSync(first.file, breakPng(Buffer.from(complete)))
    const restored = f.value()
    assert.deepEqual([restored.width, restored.height], [64, 48])
    assert.deepEqual(readFileSync(restored.file), complete)
  })
}

test('a failed poster extraction cannot publish a partial image or leave temporary files', () => {
  const f = fixture()
  const poster = f.value()
  rmSync(poster.file)
  const failed = f.invoke('poster', f.interrupt())
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /simulated interrupted video extraction/)
  assert.equal(existsSync(poster.file), false)
  assert.deepEqual(readdirSync(dirname(poster.file)), [])
  assert.deepEqual([f.value().width, f.value().height], [64, 48])
})

test('an interrupted animation extraction preserves the existing poster', () => {
  const f = fixture()
  const poster = f.value()
  const original = readFileSync(poster.file)
  const failed = f.invoke('frames', f.interrupt())
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /simulated interrupted video extraction/)
  assert.deepEqual(readFileSync(poster.file), original)
  assert.deepEqual([f.value().width, f.value().height], [64, 48])
})

test('an interrupted recut preserves already published animation frames', () => {
  const f = fixture()
  const frames = f.value('frames')
  const first = join(frames.dir, 'f00001.png')
  const original = readFileSync(first)
  rmSync(join(frames.dir, `f${String(frames.count).padStart(5, '0')}.png`))
  const failed = f.invoke('frames', f.interrupt())
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /simulated interrupted video extraction/)
  assert.deepEqual(readFileSync(first), original)
  assert.deepEqual(f.value('frames'), frames)
})

test('an animation whose first frame is truncated is regenerated', () => {
  const f = fixture()
  const frames = f.value('frames')
  const first = join(frames.dir, 'f00001.png')
  const original = readFileSync(first)
  writeFileSync(first, Buffer.alloc(24))
  assert.deepEqual(f.value('frames'), frames)
  assert.deepEqual(readFileSync(first), original)
})
