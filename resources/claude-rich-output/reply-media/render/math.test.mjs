import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, after } from 'node:test'
const made = []
after(() => made.forEach((file) => rmSync(file, { force: true })))

import { ZOOM } from './render.mjs'

for (const source of [
  String.raw`|x| = \begin{cases} x & \text{if } x \ge 0 \\ -x & \text{if } x < 0 \end{cases}`,
  String.raw`x < y`,
  String.raw`\text{A \& B} \quad x > 0`,
  String.raw`\begin{aligned} a &< b \\ b &> c \end{aligned}`
]) {
  test(`XML serialization preserves ${source}`, () => {
    const result = math(source)
    assert.equal(result.status, 0, result.stderr)
    const { file, width, height } = JSON.parse(result.stdout)
    made.push(file)
    assert.ok(width > 0 && height > 0)
    assert.equal(readFileSync(file).toString('latin1', 1, 4), 'PNG')
  })
}

const math = (source) =>
  spawnSync('node', [join(import.meta.dirname, 'math.mjs')], { input: source, encoding: 'utf8' })

test('a complete cached formula is reused; a truncated entry is regenerated', () => {
  const source = `x_{${process.pid}} = \\frac{13}{29}`
  const first = math(source)
  assert.equal(first.status, 0, first.stderr)
  const result = JSON.parse(first.stdout)
  made.push(result.file)
  const pixels = readFileSync(result.file)
  utimesSync(result.file, 1, 1)
  const again = math(source)
  assert.equal(again.status, 0, again.stderr)
  assert.deepEqual(JSON.parse(again.stdout), result)
  assert.equal(statSync(result.file).mtimeMs, 1000, 'cache hit must not rerun rasterization')
  writeFileSync(result.file, pixels.subarray(0, 40))
  const repaired = math(source)
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.deepEqual(JSON.parse(repaired.stdout), result)
  assert.deepEqual(readFileSync(result.file), pixels)
})

for (const source of ['\\frac{a}{b}', '\\sum_{i=0}^n x_i', '\\int_0^1 f(x)\\,dx']) {
  test(`math draws ${source} a few rows of text tall`, () => {
    const { file, width, height } = JSON.parse(math(source).stdout)
    made.push(file)
    const png = readFileSync(file)

    assert.equal(png.toString('latin1', 1, 4), 'PNG')
    assert.equal(png.readUInt32BE(16), Math.round(width * ZOOM))
    assert.equal(png.readUInt32BE(20), Math.round(height * ZOOM))
    assert.ok(width > 10 && width < 100 && height > 20 && height < 60, `${width} x ${height}`)
  })
}

test('math fails on what it cannot draw, with nothing on stdout', () => {
  const failures = [
    ['\\foo{x}', /Undefined control sequence/],
    ['\\frac{a}{', /Missing close brace/],
    ['x \\tag{1}', /tag/]
  ]

  for (const [source, message] of failures) {
    const run = math(source)

    assert.notEqual(run.status, 0, source)
    assert.equal(run.stdout, '', source)
    assert.match(run.stderr, message)
  }
})

test('light and dark formulas use separate cache files', () => {
  const source = String.raw`x=\frac{1}{2}`
  const draw = (theme) => {
    const result = spawnSync('node', [join(import.meta.dirname, 'math.mjs')], {
      input: source,
      encoding: 'utf8',
      env: { ...process.env, NEONCOAT_MEDIA_THEME: theme }
    })
    assert.equal(result.status, 0, result.stderr)
    const rendered = JSON.parse(result.stdout)
    made.push(rendered.file)
    return rendered
  }
  const light = draw('light'),
    dark = draw('dark')
  assert.notEqual(light.file, dark.file)
  assert.equal(light.width, dark.width)
  assert.equal(light.height, dark.height)
  assert.notDeepEqual(readFileSync(light.file), readFileSync(dark.file))
})
