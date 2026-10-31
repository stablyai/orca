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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'picture-cache-test-')))
after(() => rmSync(root, { recursive: true, force: true }))
writeFileSync(
  join(root, 'image.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="red"/></svg>'
)
const png = join(root, 'image.png')
const rasterized = spawnSync('rsvg-convert', ['--output', png, join(root, 'image.svg')])
assert.equal(rasterized.status, 0, rasterized.stderr?.toString())
const result = spawnSync('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-i',
  png,
  '-frames:v',
  '1',
  '-threads',
  '1',
  join(root, 'image.jpg')
])
assert.equal(result.status, 0, result.stderr?.toString())
// The lossless 12x8 input exercises decoding without requiring a host WebP encoder.
writeFileSync(
  join(root, 'image.webp'),
  Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvC8ABAAcQ/Y/+ByKi/wEA', 'base64')
)

function fixture(extension) {
  const cache = realpathSync(mkdtempSync(join(root, 'cache-')))
  const path = join(root, `image.${extension}`)
  const invoke = (preload) =>
    spawnSync(
      process.execPath,
      [...(preload ? ['--require', preload] : []), join(import.meta.dirname, 'picture.mjs')],
      {
        input: path,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: cache, TMP: cache, TEMP: cache, LOCALAPPDATA: cache }
      }
    )
  const value = (preload) => {
    const run = invoke(preload)
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout)
  }
  const converter = (mode) => {
    const file = join(cache, 'converter.cjs')
    writeFileSync(
      file,
      `
const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, ...rest) {
  if (['rsvg-convert', 'sips', 'ffmpeg'].includes(command)) {
    if (${JSON.stringify(mode)} === 'forbidden') throw new Error('cached picture must not convert again');
    const target = command === 'rsvg-convert' ? args[args.indexOf('--output') + 1] : args.at(-1);
    fs.writeFileSync(target, Buffer.alloc(24));
    return { status: ${mode === 'invalid' ? 0 : 1}, stderr: ${JSON.stringify(mode === 'invalid' ? '' : 'simulated interrupted picture conversion')} };
  }
  return original(command, args, ...rest);
};
require('node:module').syncBuiltinESMExports();
`
    )
    return file
  }
  return { invoke, value, converter }
}

for (const extension of ['svg', 'jpg', 'webp']) {
  test(`an unchanged ${extension} reuses its complete cache while converters are unavailable`, () => {
    const f = fixture(extension)
    const first = f.value()
    const bytes = readFileSync(first.file)
    assert.deepEqual(f.value(f.converter('forbidden')), first)
    assert.deepEqual(readFileSync(first.file), bytes)
  })

  test(`a truncated ${extension} cache is regenerated for the unchanged source`, () => {
    const f = fixture(extension)
    const first = f.value()
    const bytes = readFileSync(first.file)
    writeFileSync(first.file, Buffer.alloc(24))
    assert.deepEqual(f.value(), first)
    assert.deepEqual(readFileSync(first.file), bytes)
  })

  test(`interrupted ${extension} conversion cannot publish a partial image`, () => {
    const f = fixture(extension)
    const first = f.value()
    rmSync(first.file)
    const failed = f.invoke(f.converter('interrupt'))
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /simulated interrupted picture conversion/)
    assert.equal(existsSync(first.file), false)
    assert.deepEqual(readdirSync(dirname(first.file)), [])
    assert.deepEqual(f.value(), first)
  })
}

test('a converter reporting success with a truncated PNG cannot publish it', () => {
  const f = fixture('svg')
  const first = f.value()
  rmSync(first.file)
  const failed = f.invoke(f.converter('invalid'))
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /conversion did not produce a complete PNG/)
  assert.equal(existsSync(first.file), false)
  assert.deepEqual(readdirSync(dirname(first.file)), [])
  assert.deepEqual(f.value(), first)
})
