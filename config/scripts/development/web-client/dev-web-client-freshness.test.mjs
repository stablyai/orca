import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  captureDevWebClientInputs,
  isDevWebClientFresh,
  recordDevWebClientInputs
} from './dev-web-client-freshness.mjs'

const roots = []
const OLD = new Date(Date.now() - 120_000)
const BUILT = new Date(Date.now() - 60_000)
const EDITED = new Date()

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-dev-web-freshness-'))
  roots.push(root)
  const files = [
    'vite.web.config.ts',
    'src/renderer/src/app.tsx',
    'src/renderer/src/app.test.tsx',
    'src/renderer/src/app.spec.ts',
    'src/renderer/src/main.css',
    'src/shared/value.ts',
    'src/shared/value.test.ts',
    'src/preload/api-types.ts',
    'out/web/web-index.html'
  ]
  const directories = new Set()
  for (const file of files) {
    const absolute = join(root, file)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, '')
    utimesSync(absolute, OLD, OLD)
    for (let directory = dirname(absolute); directory !== root; directory = dirname(directory)) {
      directories.add(directory)
    }
  }
  for (const directory of directories) {
    utimesSync(directory, OLD, OLD)
  }
  utimesSync(join(root, 'out/web/web-index.html'), BUILT, BUILT)
  return root
}

it.each(['add', 'delete', 'rename'])(
  'invalidates a tracked bundle after a production source %s with old timestamps',
  (operation) => {
    const root = fixture()
    expect(isDevWebClientFresh(root)).toBe(true)
    if (operation !== 'add') {
      rmSync(join(root, 'src/renderer/src/app.tsx'))
    }
    if (operation !== 'delete') {
      const file = join(root, 'src/renderer/src/added.tsx')
      writeFileSync(file, '')
      utimesSync(file, OLD, OLD)
    }
    utimesSync(join(root, 'src/renderer/src'), OLD, OLD)
    expect(isDevWebClientFresh(root)).toBe(false)
  }
)

it('invalidates a tracked bundle when a source is removed in a nested directory', () => {
  const root = fixture()
  const directory = join(root, 'src/shared/nested')
  mkdirSync(directory)
  writeFileSync(join(directory, 'value.ts'), '')
  utimesSync(join(directory, 'value.ts'), OLD, OLD)
  utimesSync(directory, OLD, OLD)
  utimesSync(dirname(directory), OLD, OLD)
  expect(isDevWebClientFresh(root)).toBe(true)
  rmSync(directory, { recursive: true })
  utimesSync(dirname(directory), OLD, OLD)
  expect(isDevWebClientFresh(root)).toBe(false)
})

it('adopts a fresh replacement output without reusing its previous inventory', () => {
  const root = fixture()
  expect(isDevWebClientFresh(root)).toBe(true)
  writeFileSync(join(root, 'src/renderer/src/app.tsx'), 'updated')
  utimesSync(join(root, 'src/renderer/src/app.tsx'), BUILT, BUILT)
  utimesSync(join(root, 'out/web/web-index.html'), EDITED, EDITED)
  expect(isDevWebClientFresh(root)).toBe(true)
})

it('retains the inputs from before a build so concurrent edits invalidate its output', () => {
  const root = fixture()
  const inputs = captureDevWebClientInputs(root)
  writeFileSync(join(root, 'src/shared/value.ts'), 'changed while building')
  utimesSync(join(root, 'out/web/web-index.html'), EDITED, EDITED)
  recordDevWebClientInputs(root, inputs)
  expect(isDevWebClientFresh(root)).toBe(false)
})

it('detects same-size atomic replacement with a restored mtime', () => {
  const root = fixture()
  const file = join(root, 'src/shared/value.ts')
  const replacement = join(root, 'replacement.ts')
  expect(isDevWebClientFresh(root)).toBe(true)
  writeFileSync(replacement, '')
  utimesSync(replacement, OLD, OLD)
  const originalIdentity = statSync(file, { bigint: true })
  const replacementIdentity = statSync(replacement, { bigint: true })
  expect([replacementIdentity.dev, replacementIdentity.ino]).not.toEqual([
    originalIdentity.dev,
    originalIdentity.ino
  ])
  renameSync(replacement, file)
  utimesSync(dirname(file), OLD, OLD)
  expect(isDevWebClientFresh(root)).toBe(false)
})
