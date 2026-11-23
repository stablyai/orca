import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'

import {
  collectLocalizationReferences,
  LOCALIZATION_SOURCE_ROOTS
} from './verify-localization-catalog.mjs'
import { collectRuntimeRequiredKeys } from './generate-runtime-required-english-catalog.mjs'

let root

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = undefined
  }
})

it('reuses imported readonly string defaults without shipping duplicate boot entries', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'orca-localization-fallbacks-'))
  for (const sourceRoot of LOCALIZATION_SOURCE_ROOTS) {
    const target = path.join(root, sourceRoot)
    if (path.extname(target)) {
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, 'export {}', 'utf8')
    } else {
      mkdirSync(target, { recursive: true })
    }
  }
  const componentDir = path.join(root, 'src/renderer/src/components')
  mkdirSync(componentDir, { recursive: true })
  writeFileSync(
    path.join(componentDir, 'Example.tsx'),
    `import { COPY as defaults } from './copy'
translate('test.literal', defaults.literal)
translate('test.dynamic', defaults.dynamic)
function shadow(defaults) { return translate('test.shadow', defaults.literal) }
`,
    'utf8'
  )
  writeFileSync(
    path.join(componentDir, 'copy.ts'),
    `export const COPY = {
  literal: 'Literal default', dynamic: computeDefault()
} as const`
  )
  // A nested binding makes the import ambiguous; keep all such defaults in the boot catalog.
  let references = await collectLocalizationReferences(root)
  expect(
    references
      .filter((reference) => reference.key.startsWith('test.'))
      .map(({ key, fallback }) => [key, fallback])
  ).toStrictEqual([
    ['test.literal', undefined],
    ['test.dynamic', undefined],
    ['test.shadow', undefined]
  ])
  writeFileSync(
    path.join(componentDir, 'Example.tsx'),
    `import { COPY as defaults } from './copy'
translate('test.literal', defaults.literal)
translate('test.dynamic', defaults.dynamic)
`
  )
  references = await collectLocalizationReferences(root)
  expect(
    collectRuntimeRequiredKeys(
      new Map([
        ['test.literal', 'Literal default'],
        ['test.dynamic', 'Runtime default']
      ]),
      references
    )
  ).toEqual(new Set(['test.dynamic']))
  writeFileSync(
    path.join(componentDir, 'copy.ts'),
    `export const COPY = { literal: 'Changed default' } as const`
  )
  references = await collectLocalizationReferences(root)
  expect(
    collectRuntimeRequiredKeys(new Map([['test.literal', 'Literal default']]), references)
  ).toEqual(new Set(['test.literal']))
})
