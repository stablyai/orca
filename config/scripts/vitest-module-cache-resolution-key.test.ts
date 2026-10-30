import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createResolutionFingerprint,
  hasExpandedImport
} from './vitest-module-cache-resolution-key'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-resolution-key-'))
  roots.push(root)
  mkdirSync(join(root, 'src/lib/foo'), { recursive: true })
  writeFileSync(join(root, 'src/lib/foo/index.ts'), '')
  return root
}

const source = "import a from './lib/foo'\nimport b from '@/lib/foo?raw'"
const aliases = (root: string) => [{ find: '@', replacement: join(root, 'src') }]

it.each([
  ['a same-stem sibling shadows a directory index', 'src/lib/foo.ts'],
  ['a higher-precedence extension appears', 'src/lib/foo.mts'],
  ['another index candidate appears', 'src/lib/foo/index.mts'],
  ['the directory gains a package.json', 'src/lib/foo/package.json']
])('changes the key when %s', (_, added) => {
  const root = fixture()
  const before = createResolutionFingerprint(root, aliases(root))(join(root, 'src/a.ts'), source)
  writeFileSync(join(root, added), '{}')
  const after = createResolutionFingerprint(root, aliases(root))(join(root, 'src/a.ts'), source)
  expect(after).not.toBe(before)
})

it('keeps the key when an unrelated sibling appears', () => {
  const root = fixture()
  const before = createResolutionFingerprint(root, aliases(root))(join(root, 'src/a.ts'), source)
  writeFileSync(join(root, 'src/lib/bar.ts'), '')
  const after = createResolutionFingerprint(root, aliases(root))(join(root, 'src/a.ts'), source)
  expect(after).toBe(before)
})

it.each([
  ['import(`./locales/${name}.ts`)', true],
  ["import('./locales/' + name + '.ts')", true],
  ['import.meta.glob("./*.ts")', true],
  ["import('./locales/en.ts')", false],
  ['import(specifier)', false]
])('treats %s as directory-dependent: %s', (code, expected) => {
  expect(hasExpandedImport(code)).toBe(expected)
})
