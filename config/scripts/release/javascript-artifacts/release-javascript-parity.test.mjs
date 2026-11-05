import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  annotateJavascriptParityFiles,
  compareJavascriptParityFiles
} from './release-javascript-parity.mjs'

const directories = []

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

it('normalizes hashed JSON assets while rejecting content and reference changes', () => {
  const entries = (hash, content, reference = hash) => ({
    [`renderer/assets/de-${hash}.json`]: content,
    'renderer/assets/i18n.js': `fetch("./de-${reference}.json")`,
    'renderer/.vite/manifest.json': JSON.stringify({ locale: { file: `assets/de-${hash}.json` } }),
    'renderer/.orca-web-client-files.json': JSON.stringify([`assets/de-${hash}.json`])
  })
  const before = inventory(entries('AAAAAAAA', '{\r\n"hello":"Hallo"\r\n}\r\n'))
  const after = inventory(entries('BBBBBBBB', '{\n"hello":"Hallo"\n}\n'))
  expect(compareJavascriptParityFiles(before, after)).toEqual([])
  expect(
    compareJavascriptParityFiles(
      before,
      inventory(entries('BBBBBBBB', '{\n"hello":"Geändert"\n}\n'))
    )
  ).toEqual(['renderer/assets/de.json'])
  expect(
    compareJavascriptParityFiles(
      before,
      inventory(entries('BBBBBBBB', '{\n"hello":"Hallo"\n}\n', 'CCCCCCCC'))
    )
  ).toEqual(['renderer/assets/i18n.js'])
  expect(compareJavascriptParityFiles(before, [])).toContain('renderer/assets/de.json')
  for (const reference of ['de.json', '@asset:de.json', '@asset:de.json@']) {
    const broken = entries('BBBBBBBB', '{\n"hello":"Hallo"\n}\n')
    broken['renderer/assets/i18n.js'] = `fetch("./${reference}")`
    expect(compareJavascriptParityFiles(before, inventory(broken))).toEqual([
      'renderer/assets/i18n.js'
    ])
  }
  for (const [path, content] of [
    ['renderer/.vite/manifest.json', '{"locale":{"file":"assets/\\u0040asset:de.json\\u0040"}}'],
    ['renderer/.orca-web-client-files.json', '["assets/\\u0040asset:de.json\\u0040"]']
  ]) {
    const broken = entries('BBBBBBBB', '{\n"hello":"Hallo"\n}\n')
    broken[path] = content
    expect(compareJavascriptParityFiles(before, inventory(broken))).toEqual([path])
  }
  for (const [path, content] of [
    ['renderer/.vite/manifest.json', '{"locale":{"file":"assets/de\\u002dBBBBBBBB.json"}}'],
    ['renderer/.orca-web-client-files.json', '["assets/de\\u002dBBBBBBBB.json"]']
  ]) {
    const escaped = entries('BBBBBBBB', '{\n"hello":"Hallo"\n}\n')
    escaped[path] = content
    expect(compareJavascriptParityFiles(before, inventory(escaped))).toEqual([])
  }
  const suffixEntries = (reference) => ({
    ...entries('AAAAAAAA', '{"hello":"Hallo"}'),
    'renderer/assets/de.json-BBBBBBBB.json': '{}',
    'renderer/assets/i18n.js': `fetch("./${reference}")`
  })
  expect(
    compareJavascriptParityFiles(
      inventory(suffixEntries('de-AAAAAAAA.json.json')),
      inventory(suffixEntries('de.json-BBBBBBBB.json'))
    )
  ).toEqual(['renderer/assets/i18n.js'])
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
