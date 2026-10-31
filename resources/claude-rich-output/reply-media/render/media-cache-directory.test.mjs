import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { privateMediaDirectory } from './media-cache-directory.mjs'

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'private-media-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('creates reusable private cache and frame directories', (t) => {
  const directory = join(temporary(t), 'cache')
  assert.equal(privateMediaDirectory(directory), directory)
  assert.equal(privateMediaDirectory(directory), directory)
  const frames = privateMediaDirectory(join(directory, 'frames'))
  if (process.platform !== 'win32') {
    for (const path of [directory, frames]) {
      assert.equal(lstatSync(path).mode & 0o777, 0o700)
    }
  }
})

test('refuses a pre-existing symlink without touching its target', (t) => {
  const root = temporary(t)
  const target = join(root, 'target')
  mkdirSync(target, { mode: 0o700 })
  const sentinel = join(target, 'sentinel')
  writeFileSync(sentinel, 'untouched')
  const link = join(root, 'cache')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => privateMediaDirectory(link), /Unsafe reply-media cache/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
})

test('refuses a regular file in place of the cache directory', (t) => {
  const file = join(temporary(t), 'cache')
  writeFileSync(file, 'untouched')
  assert.throws(() => privateMediaDirectory(file), /Unsafe reply-media cache/)
  assert.equal(readFileSync(file, 'utf8'), 'untouched')
})

test('refuses an existing POSIX directory with shared access or a different owner', (t) => {
  if (typeof process.getuid !== 'function') {
    return
  }
  const directory = join(temporary(t), 'cache')
  mkdirSync(directory, { mode: 0o700 })
  for (const mode of [0o750, 0o705, 0o770]) {
    chmodSync(directory, mode)
    assert.throws(() => privateMediaDirectory(directory), /Unsafe reply-media cache/)
    assert.equal(lstatSync(directory).mode & 0o777, mode)
  }
  chmodSync(directory, 0o700)
  const owner = process.getuid()
  t.mock.method(process, 'getuid', () => owner + 1)
  assert.throws(() => privateMediaDirectory(directory), /Unsafe reply-media cache/)
})

for (const entry of ['math.mjs', 'picture.mjs', 'video.mjs']) {
  test(`${entry} refuses an unsafe cache before starting an output converter`, (t) => {
    const root = temporary(t)
    const target = join(root, 'other-user-data')
    mkdirSync(target, { mode: 0o700 })
    writeFileSync(join(target, 'sentinel'), 'untouched')
    const cache = join(
      root,
      typeof process.getuid === 'function'
        ? `claude-reply-media-${process.getuid()}`
        : 'claude-reply-media'
    )
    symlinkSync(target, cache, process.platform === 'win32' ? 'junction' : 'dir')
    const picture = join(root, 'input.svg')
    writeFileSync(picture, '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"/>')
    const clip = join(root, 'input.mp4')
    writeFileSync(clip, '')
    const result = spawnSync(process.execPath, [join(import.meta.dirname, entry)], {
      input:
        entry === 'math.mjs'
          ? String.raw`x = \frac{1}{2}`
          : entry === 'picture.mjs'
            ? picture
            : clip,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, LOCALAPPDATA: root }
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Unsafe reply-media cache/)
    assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'untouched')
  })
}

function cacheFor(t) {
  const root = temporary(t)
  const directory = privateMediaDirectory(
    join(
      root,
      typeof process.getuid === 'function'
        ? `claude-reply-media-${process.getuid()}`
        : 'claude-reply-media'
    )
  )
  const maintain = (keep) => {
    const module = pathToFileURL(join(import.meta.dirname, 'media-cache-directory.mjs')).href
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { mediaCacheDirectory } from ${JSON.stringify(module)}; console.log(mediaCacheDirectory(${JSON.stringify(keep)}))`
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, LOCALAPPDATA: root }
      }
    )
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.trim(), directory)
  }
  const entry = (digit, megabytes, age, frames = false) => {
    const path = join(directory, digit.repeat(40) + (frames ? '' : '.png'))
    const file = frames ? join(privateMediaDirectory(path), 'f00001.png') : path
    writeFileSync(file, '')
    truncateSync(file, megabytes * 1024 * 1024)
    const date = new Date(Date.now() - age)
    utimesSync(file, date, date)
    utimesSync(path, date, date)
    return path
  }
  return { root, directory, maintain, entry }
}

test('expires old generated previews but preserves the current entry, unknown files and symlink targets', (t) => {
  const { root, directory, maintain, entry } = cacheFor(t)
  const old = 8 * 24 * 60 * 60 * 1000
  const picture = entry('1', 1, old)
  const frames = entry('2', 1, old, true)
  const current = entry('3', 1, old)
  const unchangedMtime = lstatSync(current).mtimeMs
  const other = join(directory, 'user-not-a-generated-cache.txt')
  writeFileSync(other, 'preserve unknown entries')
  const target = join(root, 'outside-cache')
  mkdirSync(target, { mode: 0o700 })
  const sentinel = join(target, 'sentinel')
  writeFileSync(sentinel, 'untouched')
  symlinkSync(
    target,
    join(directory, '4'.repeat(40)),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const orphan = join(directory, `${'5'.repeat(40)}.png.used`)
  writeFileSync(orphan, '')
  utimesSync(orphan, new Date(0), new Date(0))
  const pending = join(directory, `${'6'.repeat(40)}.png.used`)
  writeFileSync(pending, '')
  maintain(`${'3'.repeat(40)}.png`)
  assert.equal(existsSync(picture), false)
  assert.equal(existsSync(frames), false)
  assert.equal(existsSync(current), true)
  assert.equal(lstatSync(current).mtimeMs, unchangedMtime)
  assert.equal(existsSync(orphan), false)
  assert.equal(existsSync(pending), true)
  assert.equal(readFileSync(other, 'utf8'), 'preserve unknown entries')
  assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
  rmSync(current)
  maintain(`${'3'.repeat(40)}.png`)
  assert.equal(existsSync(`${current}.used`), false)
})

test('reclaims the oldest generated video directory to meet the shared 512 MiB target', (t) => {
  const { maintain, entry } = cacheFor(t)
  const oldFrames = entry('1', 320, 60 * 60 * 1000, true)
  const newerPicture = entry('2', 240, 30 * 60 * 1000)
  const current = entry('3', 10, 0, true)
  maintain('3'.repeat(40))
  assert.equal(existsSync(oldFrames), false)
  assert.equal(existsSync(newerPicture), true)
  assert.equal(existsSync(current), true)
})

test('keeps recently used previews during active overage and retries collection when they age', (t) => {
  const { maintain, entry } = cacheFor(t)
  const recent = entry('1', 520, 60 * 1000, true)
  const old = entry('2', 1, 60 * 60 * 1000)
  maintain()
  assert.equal(existsSync(recent), true)
  assert.equal(existsSync(old), false)
  const date = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(recent, date, date)
  maintain()
  assert.equal(existsSync(recent), false)
})

for (const suffix of ['123.tmp', '123.01234567-89ab-4cde-8fab-0123456789ab.png']) {
  test(`collects an abandoned conversion ${suffix} while preserving active and unknown output`, (t) => {
    const { directory, maintain } = cacheFor(t)
    const old = join(directory, `${'a'.repeat(40)}.png.${suffix}`)
    const active = join(directory, `${'b'.repeat(40)}.png.${suffix}`)
    const unknown = join(directory, 'unrecognized-conversion.png')
    writeFileSync(old, 'terminated conversion')
    writeFileSync(active, 'still converting')
    writeFileSync(unknown, 'not a generated output name')
    const date = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(old, date, date)
    maintain()
    assert.equal(existsSync(old), false)
    assert.equal(readFileSync(active, 'utf8'), 'still converting')
    assert.equal(readFileSync(unknown, 'utf8'), 'not a generated output name')
  })
}
