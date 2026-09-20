/**
 * Every text input the source-control hub and the diff review page reach, and the size it declares.
 *
 * iOS zooms the page on focus of any input under 16px and does not zoom back out, so the document
 * spends the rest of that typing session at a scale other than 1 — which `keyboard-occlusion.web.ts`
 * reads as "not a keyboard" on purpose, because geometry cannot separate a zoom from a keyboard.
 * One 14px input anywhere in the closure is therefore enough to stop the commit bar and the note
 * composer lifting, whatever those two inputs themselves declare.
 *
 * So the rule is the closure rather than the two seam-served sites: the first version of this fix
 * raised those two and left eight others in the same closures at 14px, which made the seam's own
 * rationale false page-wide.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  TEXT_INPUT_FONT_SIZE_SEAM,
  textInputFontSizeOffenders,
  unresolvedTextInputStyles
} from './mobile-web-app-text-input-font-size-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const HUB = 'app/h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW = 'app/h/[hostId]/review/[worktreeId].tsx'

/** A scratch module tree, so a planted offender never lands in the tree other censuses walk. */
function plant(files) {
  const root = mkdtempSync(join(tmpdir(), 'orca-text-input-census-'))
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path.slice(0, path.lastIndexOf('/'))), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return root
}

describe('the size a text input declares, as the census reads it', () => {
  it('names the line the size is set on, which may not be the file the input is in', () => {
    const root = plant({
      'src/ui/Field.tsx': [
        "import { styles } from './field-styles'",
        'export const Field = () => <TextInput style={styles.input} />'
      ].join('\n'),
      'src/ui/field-styles.ts': [
        'export const styles = {',
        '  label: { fontSize: 12 },',
        '  input: { fontSize: 14 }',
        '}'
      ].join('\n')
    })
    try {
      expect(
        textInputFontSizeOffenders(root, { local: ['src/ui/Field.tsx', 'src/ui/field-styles.ts'] })
      ).toEqual(['src/ui/field-styles.ts:3'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('follows a spread into the module that really holds the key', () => {
    // Both screens this rule exists for reach their input through `{ ...base, ...list }`. A walk
    // that stopped at the first module would find no size here and report the offence as absent.
    const root = plant({
      'src/ui/Field.tsx': [
        "import { styles } from './field-styles'",
        'export const Field = () => <TextInput style={styles.input} />'
      ].join('\n'),
      'src/ui/field-styles.ts': [
        "import { listStyles } from './list-styles'",
        'export const styles = { ...listStyles }'
      ].join('\n'),
      'src/ui/list-styles.ts': 'export const listStyles = { input: { fontSize: 14 } }'
    })
    try {
      expect(
        textInputFontSizeOffenders(root, {
          local: ['src/ui/Field.tsx', 'src/ui/field-styles.ts', 'src/ui/list-styles.ts']
        })
      ).toEqual(['src/ui/list-styles.ts:1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('separates a style it could not follow from one that sets no size', () => {
    // An offender list only says every input is on the seam if every input was read. A style the
    // walk cannot follow has to surface here rather than pass as a clean input.
    const root = plant({
      'src/ui/Field.tsx': [
        "import { styles } from './field-styles'",
        "import { missing } from 'some-package'",
        'export const Bare = () => <TextInput style={styles.bare} />',
        'export const Gone = () => <TextInput style={missing.input} />'
      ].join('\n'),
      'src/ui/field-styles.ts': 'export const styles = { bare: { padding: 8 } }'
    })
    try {
      const closure = { local: ['src/ui/Field.tsx', 'src/ui/field-styles.ts'] }
      expect(textInputFontSizeOffenders(root, closure)).toEqual([])
      expect(unresolvedTextInputStyles(root, closure)).toEqual(['src/ui/Field.tsx:4 (input)'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('takes the seam as the answer, and an absent size as nothing to answer for', () => {
    // A style with no `fontSize` inherits; the floor is about the size an input declares.
    const root = plant({
      'src/ui/Field.tsx': [
        "import { styles } from './field-styles'",
        'export const Field = () => <TextInput style={styles.input} />',
        'export const Other = () => <TextInput style={styles.bare} />'
      ].join('\n'),
      'src/ui/field-styles.ts': [
        'export const styles = {',
        '  input: { fontSize: TEXT_INPUT_FONT_SIZE },',
        '  bare: { padding: 8 }',
        '}'
      ].join('\n')
    })
    try {
      expect(
        textInputFontSizeOffenders(root, { local: ['src/ui/Field.tsx', 'src/ui/field-styles.ts'] })
      ).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describeClosure(
  'the text inputs the source-control and review pages reach',
  () => {
    it.each([HUB, REVIEW])('takes every input size through the seam: %s', async (route) => {
      const closure = await mobileWebAppRouteClosure(route)
      expect(textInputFontSizeOffenders(mobileDir, closure)).toEqual([])
    })

    it.each([HUB, REVIEW])(
      'reads every input it found, so the list above is complete: %s',
      async (route) => {
        const closure = await mobileWebAppRouteClosure(route)
        expect(unresolvedTextInputStyles(mobileDir, closure)).toEqual([])
      }
    )

    it.each([HUB, REVIEW])('carries the seam, so the rule is not vacuous: %s', async (route) => {
      // Without this an empty offender list would also be what a closure reaching no text input at
      // all produces, and the census would pass against a page that has nothing to raise.
      const closure = await mobileWebAppRouteClosure(route)
      expect(closure.local).toContain(TEXT_INPUT_FONT_SIZE_SEAM)
    })
  },
  240_000
)
