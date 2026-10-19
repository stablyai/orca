import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  annotateJavascriptParityFiles,
  compareJavascriptParityFiles,
  equivalentStylesheets,
  normalizeManifestSourcePaths
} from './release-javascript-parity.mjs'

const directories = []

it('normalizes pnpm store path shortening without collapsing distinct source records', () => {
  const shortened = '../../node_modules/.pnpm/package@1_hash/node_modules/package/index.js'
  const full =
    '../../node_modules/.pnpm/package@1.0.0_patch_hash=long/node_modules/package/index.js'
  expect(
    normalizeManifestSourcePaths({ [shortened]: { src: shortened, imports: [shortened] } })
  ).toEqual(normalizeManifestSourcePaths({ [full]: { src: full, imports: [full] } }))
  expect(() => normalizeManifestSourcePaths({ [shortened]: 1, [full]: 2 })).toThrow(
    'Ambiguous manifest source paths'
  )
})
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
)

function inventory(entries) {
  const root = mkdtempSync(join(tmpdir(), 'orca-release-parity-'))
  directories.push(root)
  const files = Object.entries(entries).map(([path, content]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
    return { path, sha256: createHash('sha256').update(content).digest('hex') }
  })
  return annotateJavascriptParityFiles(root, files)
}

it('allows one decimal unit of native P3 rounding and its asset reference hashes', () => {
  const before = inventory({
    'renderer/assets/theme-AAAAAAAA.css': '.x{color:color(display-p3 .134023 .230646 .695537)}',
    'renderer/assets/index-BBBBBBBB.js': 'import "./theme-AAAAAAAA.css";run()',
    'renderer/index.html': '<script src="assets/index-BBBBBBBB.js"></script>'
  })
  const after = inventory({
    'renderer/assets/theme-CCCCCCCC.css': '.x{color:color(display-p3 .134023 .230647 .695537)}',
    'renderer/assets/index-DDDDDDDD.js': 'import "./theme-CCCCCCCC.css";run()',
    'renderer/index.html': '<script src="assets/index-DDDDDDDD.js"></script>'
  })
  expect(compareJavascriptParityFiles(before, after)).toEqual([])
})

it('rejects meaningful color changes and every non-color stylesheet change', () => {
  expect(
    equivalentStylesheets(
      'a{color:color(display-p3 .1 .2 .3)}',
      'a{color:color(display-p3 .1 .20001 .3)}'
    )
  ).toBe(false)
  expect(equivalentStylesheets('a{padding:1px}', 'a{padding:2px}')).toBe(false)
  expect(equivalentStylesheets('a{color:red}', 'b{color:red}')).toBe(false)
  expect(
    equivalentStylesheets(
      'a{color:color(display-p3 .1 .2 .3)}',
      'a{color:color(display-p3 .1 .2 .3 / .5)}'
    )
  ).toBe(false)
})

it('rejects code changes, missing files and incorrect asset references', () => {
  const before = inventory({ 'renderer/assets/index-AAAAAAAA.js': 'run()' })
  const after = inventory({ 'renderer/assets/index-BBBBBBBB.js': 'other()' })
  expect(compareJavascriptParityFiles(before, after)).toEqual(['renderer/assets/index.js'])
  expect(compareJavascriptParityFiles(before, [])).toEqual(['renderer/assets/index.js'])
  const reference = inventory({
    'renderer/assets/index-BBBBBBBB.js': 'run()',
    'renderer/index.html': '<script src="assets/missing-CCCCCCCC.js"></script>'
  })
  expect(
    compareJavascriptParityFiles(
      reference,
      inventory({
        'renderer/assets/index-DDDDDDDD.js': 'run()',
        'renderer/index.html': '<script src="assets/index-DDDDDDDD.js"></script>'
      })
    )
  ).toEqual(['renderer/index.html'])
})

it('keeps ambiguous modules distinct and portable binary files exact', () => {
  const before = inventory({
    'renderer/assets/App-AAAAAAAA.js': 'run()',
    'renderer/assets/App-BBBBBBBB.js': 'other()',
    'renderer/viewer.wasm': 'one'
  })
  expect(new Set(before.map((file) => file.comparablePath)).size).toBe(before.length)
  expect(
    compareJavascriptParityFiles(
      before,
      inventory({
        'renderer/assets/App-AAAAAAAA.js': 'run()',
        'renderer/assets/App-BBBBBBBB.js': 'other()',
        'renderer/viewer.wasm': 'two'
      })
    )
  ).toEqual(['renderer/viewer.wasm'])
})

it('matches duplicate asset stems by content while rejecting a reference to the wrong module', () => {
  const before = inventory({
    'renderer/assets/App-AAAAAAAA.js': 'desktop()',
    'renderer/assets/App-BBBBBBBB.js': 'web()',
    'renderer/index.html': '<script src="assets/App-AAAAAAAA.js"></script>'
  })
  const after = inventory({
    'renderer/assets/App-CCCCCCCC.js': 'web()',
    'renderer/assets/App-DDDDDDDD.js': 'desktop()',
    'renderer/index.html': '<script src="assets/App-DDDDDDDD.js"></script>'
  })
  expect(compareJavascriptParityFiles(before, after)).toEqual([])
  const wrong = inventory({
    'renderer/assets/App-CCCCCCCC.js': 'web()',
    'renderer/assets/App-DDDDDDDD.js': 'desktop()',
    'renderer/index.html': '<script src="assets/App-CCCCCCCC.js"></script>'
  })
  expect(compareJavascriptParityFiles(before, wrong)).toEqual(['renderer/index.html'])
})

it('preserves module identity across chained and cyclic dependencies with the same stem', () => {
  const before = inventory({
    'renderer/assets/App-AAAAAAAA.js': 'desktop();import "./App-BBBBBBBB.js"',
    'renderer/assets/App-BBBBBBBB.js': 'web();import "./App-AAAAAAAA.js"',
    'renderer/index.html': '<script src="assets/App-AAAAAAAA.js"></script>'
  })
  const after = inventory({
    'renderer/assets/App-CCCCCCCC.js': 'web();import "./App-DDDDDDDD.js"',
    'renderer/assets/App-DDDDDDDD.js': 'desktop();import "./App-CCCCCCCC.js"',
    'renderer/index.html': '<script src="assets/App-DDDDDDDD.js"></script>'
  })
  expect(compareJavascriptParityFiles(before, after)).toEqual([])
  const changed = inventory({
    'renderer/assets/App-CCCCCCCC.js': 'web();import "./App-DDDDDDDD.js"',
    'renderer/assets/App-DDDDDDDD.js': 'desktop();import "./App-DDDDDDDD.js"',
    'renderer/index.html': '<script src="assets/App-DDDDDDDD.js"></script>'
  })
  expect(compareJavascriptParityFiles(before, changed)).not.toEqual([])
})

it('normalizes generated text and SVG line endings without changing escaped string values', () => {
  const before = inventory({
    'renderer/assets/icon-AAAAAAAA.svg': '<svg>\r\n</svg>',
    'renderer/assets/index-BBBBBBBB.js': 'import "./icon-AAAAAAAA.svg";\r\nrun()'
  })
  const after = inventory({
    'renderer/assets/icon-CCCCCCCC.svg': '<svg>\n</svg>',
    'renderer/assets/index-DDDDDDDD.js': 'import "./icon-CCCCCCCC.svg";\nrun()'
  })
  expect(compareJavascriptParityFiles(before, after)).toEqual([])
  expect(
    compareJavascriptParityFiles(
      inventory({ 'shared/template.js': 'const text = "\\r\\n"' }),
      inventory({ 'shared/template.js': 'const text = "\\n"' })
    )
  ).toEqual(['shared/template.js'])
})

it('permits one printed decimal unit of native Lab rounding and rejects larger or unit changes', () => {
  expect(
    equivalentStylesheets(
      'a{color:lab(76.5514% 36.4219 15.5335)}',
      'a{color:lab(76.5514% 36.422 15.5335)}'
    )
  ).toBe(true)
  expect(
    equivalentStylesheets(
      'a{color:lab(76.5514% 36.4219 15.5335)}',
      'a{color:lab(76.5514% 36.4221 15.5335)}'
    )
  ).toBe(false)
  expect(
    equivalentStylesheets(
      'a{color:lab(76.5514% 36.4219 15.5335)}',
      'a{color:lab(76.5514 36.4219 15.5335)}'
    )
  ).toBe(false)
})

it('compares manifest keys without ordering differences while preserving import array order', () => {
  const before = inventory({
    'renderer/assets/index-AAAAAAAA.js': 'run()',
    'renderer/.vite/manifest.json':
      '{"_index-AAAAAAAA.js":{"imports":["a","b"],"file":"assets/index-AAAAAAAA.js"},"entry":1}'
  })
  const after = inventory({
    'renderer/assets/index-BBBBBBBB.js': 'run()',
    'renderer/.vite/manifest.json':
      '{"entry":1,"_index-BBBBBBBB.js":{"file":"assets/index-BBBBBBBB.js","imports":["a","b"]}}'
  })
  expect(compareJavascriptParityFiles(before, after)).toEqual([])
  const changed = inventory({
    'renderer/assets/index-BBBBBBBB.js': 'run()',
    'renderer/.vite/manifest.json':
      '{"entry":1,"_index-BBBBBBBB.js":{"file":"assets/index-BBBBBBBB.js","imports":["b","a"]}}'
  })
  expect(compareJavascriptParityFiles(before, changed)).toEqual(['renderer/.vite/manifest.json'])
})
