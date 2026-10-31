import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=',
  'base64'
)
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'picture-png-test-')))
after(() => rmSync(dir, { recursive: true, force: true }))

const picture = (path) =>
  spawnSync(process.execPath, [join(import.meta.dirname, 'picture.mjs')], {
    input: path,
    encoding: 'utf8'
  })

const zeroWidth = Buffer.from(png)
zeroWidth.writeUInt32BE(0, 16)
const zeroHeight = Buffer.from(png)
zeroHeight.writeUInt32BE(0, 20)
const wrongHeader = Buffer.from(png)
wrongHeader.write('IDAT', 12)

for (const { name, bytes } of [
  { name: 'signature-only', bytes: png.subarray(0, 8) },
  { name: 'partial-header', bytes: png.subarray(0, 20) },
  { name: 'missing-end', bytes: png.subarray(0, -12) },
  { name: 'zero-width', bytes: zeroWidth },
  { name: 'zero-height', bytes: zeroHeight },
  { name: 'wrong-header', bytes: wrongHeader }
]) {
  test(`picture rejects a ${name} PNG without publishing dimensions`, () => {
    const path = join(dir, `${name}.png`)
    writeFileSync(path, bytes)
    const run = picture(path)
    assert.notEqual(run.status, 0)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /not a complete PNG/)
    assert.deepEqual(readFileSync(path), bytes)
  })
}

test('a complete PNG passes through without a PNG extension', () => {
  const path = join(dir, 'picture without extension')
  writeFileSync(path, png)
  const run = picture(path)
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout), { file: path, width: 1, height: 1, path })
  assert.deepEqual(readFileSync(path), png)
})

test('a picture can be retried after an incomplete source finishes writing', () => {
  const path = join(dir, 'still writing.png')
  writeFileSync(path, png.subarray(0, 24))
  const incomplete = picture(path)
  assert.notEqual(incomplete.status, 0)
  assert.equal(incomplete.stdout, '')
  assert.match(incomplete.stderr, /not a complete PNG/)
  writeFileSync(path, png)
  const completed = picture(path)
  assert.equal(completed.status, 0, completed.stderr)
  assert.deepEqual(JSON.parse(completed.stdout), { file: path, width: 1, height: 1, path })
  assert.deepEqual(readFileSync(path), png)
})
