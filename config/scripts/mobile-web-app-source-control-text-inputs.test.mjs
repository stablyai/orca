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
  textInputFontSizeFloor,
  textInputFontSizeOffenders,
  unresolvedTextInputStyles
} from './mobile-web-app-text-input-font-size-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const HUB = 'app/h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW = 'app/h/[hostId]/review/[worktreeId].tsx'

/** The seam module itself, which a fixture needs on disk for an import of it to resolve. */
const SEAM_SOURCE = {
  'src/platform/text-input-font-size.ts': 'export const TEXT_INPUT_FONT_SIZE = 14'
}

/**
 * The seam's web half, seeded into every scratch tree below.
 *
 * Not a fixture detail: the floor is declared here and the census reads it here, so a tree without
 * this file is one the rule refuses to judge at all. Seeding it makes every case a tree with a
 * seam, which is what a real one is; the case that checks the refusal writes its own over the top.
 */
const FLOOR_SOURCE = {
  'src/platform/text-input-font-size.web.ts': [
    'export const TEXT_INPUT_FONT_SIZE_FLOOR = 16',
    'export const TEXT_INPUT_FONT_SIZE = 16'
  ].join('\n')
}
const SEAM_IMPORT = "import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'"

/** A scratch module tree, so a planted offender never lands in the tree other censuses walk. */
function plant(files) {
  const root = mkdtempSync(join(tmpdir(), 'orca-text-input-census-'))
  for (const [path, source] of Object.entries({ ...FLOOR_SOURCE, ...files })) {
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
      // Imported, not merely spelled: the rule reads the binding now, so a fixture that wrote the
      // name without importing it from the seam would be an offender like any other shadow.
      'src/ui/field-styles.ts': [
        SEAM_IMPORT,
        'export const styles = {',
        '  input: { fontSize: TEXT_INPUT_FONT_SIZE },',
        '  bare: { padding: 8 }',
        '}'
      ].join('\n'),
      ...SEAM_SOURCE
    })
    try {
      expect(
        textInputFontSizeOffenders(root, { local: ['src/ui/Field.tsx', 'src/ui/field-styles.ts'] })
      ).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads an inline style literal in place rather than losing it', () => {
    // `style={{ fontSize: 14 }}` names no style key, so a walk that only followed `styles.key`
    // recorded nothing at all for it: neither an offender nor a hole.
    const root = plant({
      'src/ui/Inline.tsx': [
        'export const Sized = () => <TextInput style={{ fontSize: 14 }} />',
        'export const Bare = () => <TextInput style={{ padding: 8 }} />'
      ].join('\n')
    })
    try {
      const closure = { local: ['src/ui/Inline.tsx'] }
      expect(textInputFontSizeOffenders(root, closure)).toEqual(['src/ui/Inline.tsx:1'])
      expect(unresolvedTextInputStyles(root, closure)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads an inline literal beside a style key, and the condition between them', () => {
    // `[styles.input, disabled && styles.disabled]` is the shape this tree actually uses, so the
    // members of an array — and the right of an `&&` — have to be followed, not walked as a blob.
    const root = plant({
      'src/ui/Mixed.tsx': [
        "import { styles } from './mixed-styles'",
        'export const Mixed = () => (',
        '  <TextInput style={[styles.input, disabled && styles.disabled, { fontSize: 14 }]} />',
        ')'
      ].join('\n'),
      'src/ui/mixed-styles.ts': [
        SEAM_IMPORT,
        'export const styles = {',
        '  input: { fontSize: TEXT_INPUT_FONT_SIZE },',
        '  disabled: { opacity: 0.5 }',
        '}'
      ].join('\n'),
      ...SEAM_SOURCE
    })
    try {
      const closure = {
        local: ['src/ui/Mixed.tsx', 'src/ui/mixed-styles.ts', ...Object.keys(SEAM_SOURCE)]
      }
      expect(textInputFontSizeOffenders(root, closure)).toEqual(['src/ui/Mixed.tsx:3'])
      expect(unresolvedTextInputStyles(root, closure)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The floor is the rule and the seam is the mechanism, so a literal already clear of the floor
   * satisfies it without binding to anything.
   *
   * Written as three sizes rather than one: a rule that only proved 22 passes would also be
   * satisfied by a census that stopped reading literals at all, and the 15 is the case the whole
   * seam exists for. The boundary is included because "at or above" is where an off-by-one lives.
   */
  it.each([
    ['under the floor, which is the offence the seam exists for', 15, ['src/ui/Sized.tsx:1']],
    ['exactly the floor', 16, []],
    ['well above the floor, which no binding could keep', 22, []]
  ])('reads a literal %s', (_label, size, expected) => {
    const root = plant({
      'src/ui/Sized.tsx': `export const Sized = () => <TextInput style={{ fontSize: ${size} }} />`,
      ...SEAM_SOURCE
    })
    try {
      const closure = { local: ['src/ui/Sized.tsx'] }
      expect(textInputFontSizeOffenders(root, closure)).toEqual(expected)
      expect(unresolvedTextInputStyles(root, closure)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The floor really is the seam's, checked against a seam that does not say 16.
   *
   * The first version of this case planted a floor of 16 and asserted the census read 16, which a
   * census carrying its own copy of the number passes just as happily. A tree whose seam says 20
   * is the only fixture that can tell the two apart, and the 18 below is the size that is clean
   * under one floor and an offence under the other.
   */
  it('judges against the floor the seam declares, not against a number of its own', () => {
    const root = plant({
      'src/ui/Sized.tsx': 'export const Sized = () => <TextInput style={{ fontSize: 18 }} />',
      'src/platform/text-input-font-size.web.ts': [
        'export const TEXT_INPUT_FONT_SIZE_FLOOR = 20',
        'export const TEXT_INPUT_FONT_SIZE = 20'
      ].join('\n')
    })
    try {
      expect(textInputFontSizeFloor(root)).toBe(20)
      expect(textInputFontSizeOffenders(root, { local: ['src/ui/Sized.tsx'] })).toEqual([
        'src/ui/Sized.tsx:1'
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to judge a tree whose seam declares no floor, rather than assuming one', () => {
    const root = plant({
      'src/ui/Sized.tsx': 'export const Sized = () => <TextInput style={{ fontSize: 22 }} />',
      'src/platform/text-input-font-size.ts': 'export const TEXT_INPUT_FONT_SIZE = 14',
      'src/platform/text-input-font-size.web.ts': 'export const TEXT_INPUT_FONT_SIZE = 16'
    })
    try {
      expect(() => textInputFontSizeOffenders(root, { local: ['src/ui/Sized.tsx'] })).toThrow(
        /declares no numeric/
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('names a style shape it cannot follow rather than dropping it', () => {
    const root = plant({
      'src/ui/Called.tsx': 'export const Called = () => <TextInput style={makeStyle()} />'
    })
    try {
      expect(unresolvedTextInputStyles(root, { local: ['src/ui/Called.tsx'] })).toEqual([
        'src/ui/Called.tsx:1 (makeStyle())'
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets a later spread beat a direct key, as the runtime object does', () => {
    // `{ input: safe, ...legacy }` is `legacy.input` at runtime. Answering the direct key first
    // read the safe one and called the override clean.
    const root = plant({
      'src/ui/Order.tsx': [
        "import { styles } from './order-styles'",
        'export const Order = () => <TextInput style={styles.input} />'
      ].join('\n'),
      'src/ui/order-styles.ts': [
        SEAM_IMPORT,
        "import { legacy } from './legacy-styles'",
        'export const styles = { input: { fontSize: TEXT_INPUT_FONT_SIZE }, ...legacy }'
      ].join('\n'),
      'src/ui/legacy-styles.ts': 'export const legacy = { input: { fontSize: 14 } }',
      ...SEAM_SOURCE
    })
    try {
      expect(
        textInputFontSizeOffenders(root, {
          local: [
            'src/ui/Order.tsx',
            'src/ui/order-styles.ts',
            'src/ui/legacy-styles.ts',
            ...Object.keys(SEAM_SOURCE)
          ]
        })
      ).toEqual(['src/ui/legacy-styles.ts:1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['a local constant wearing the name', 'const TEXT_INPUT_FONT_SIZE = 14'],
    ['an import of the name from elsewhere', "import { TEXT_INPUT_FONT_SIZE } from './elsewhere'"]
  ])('reads the seam as a binding, not a spelling: %s', (_label, preamble) => {
    const root = plant({
      'src/ui/Shadow.tsx': [
        "import { styles } from './shadow-styles'",
        'export const Shadow = () => <TextInput style={styles.input} />'
      ].join('\n'),
      'src/ui/shadow-styles.ts': [
        preamble,
        'export const styles = { input: { fontSize: TEXT_INPUT_FONT_SIZE } }'
      ].join('\n'),
      'src/ui/elsewhere.ts': 'export const TEXT_INPUT_FONT_SIZE = 14',
      ...SEAM_SOURCE
    })
    try {
      expect(
        textInputFontSizeOffenders(root, {
          local: [
            'src/ui/Shadow.tsx',
            'src/ui/shadow-styles.ts',
            'src/ui/elsewhere.ts',
            ...Object.keys(SEAM_SOURCE)
          ]
        })
      ).toEqual(['src/ui/shadow-styles.ts:2'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * The platform sibling, which is the file the page actually runs.
 *
 * `mobileWebAppRouteClosure` reports what esbuild resolved, and esbuild prefers `.web.tsx`/`.web.ts`
 * ahead of the native file. A census that followed an import to the native sibling would judge a
 * module no browser loads: it would clear a split whose web half is off the seam, and report one
 * whose web half is on it. Both directions are below, because only one of them is a false pass.
 */
describe('a style module with a platform sibling', () => {
  const FIELD = [
    "import { styles } from './field-styles'",
    'export const Field = () => <TextInput style={styles.input} />'
  ].join('\n')

  it('is read through its .web sibling, so a raised web size clears the native one', () => {
    const root = plant({
      'src/ui/Field.tsx': FIELD,
      'src/ui/field-styles.ts': 'export const styles = { input: { fontSize: 12 } }',
      'src/ui/field-styles.web.ts': [
        SEAM_IMPORT.replace('../platform', '../platform'),
        'export const styles = { input: { fontSize: TEXT_INPUT_FONT_SIZE } }'
      ].join('\n'),
      ...SEAM_SOURCE
    })
    try {
      const closure = { local: ['src/ui/Field.tsx', 'src/ui/field-styles.web.ts'] }
      expect(textInputFontSizeOffenders(root, closure)).toEqual([])
      expect(unresolvedTextInputStyles(root, closure)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is reported when the .web half is the one off the seam, native half notwithstanding', () => {
    const root = plant({
      'src/ui/Field.tsx': FIELD,
      'src/ui/field-styles.ts': [
        SEAM_IMPORT,
        'export const styles = { input: { fontSize: TEXT_INPUT_FONT_SIZE } }'
      ].join('\n'),
      'src/ui/field-styles.web.ts': 'export const styles = { input: { fontSize: 12 } }',
      ...SEAM_SOURCE
    })
    try {
      expect(
        textInputFontSizeOffenders(root, {
          local: ['src/ui/Field.tsx', 'src/ui/field-styles.web.ts']
        })
      ).toEqual(['src/ui/field-styles.web.ts:1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The seam has a `.web.ts` sibling of its own, and that is the whole point of it: the native file
   * is the app's body size and the web one raises it past the focus-zoom floor. Preferring the web
   * file when following an import must not make every seam binding stop naming the seam.
   */
  it('still counts the seam as the seam when the seam itself is the split one', () => {
    const root = plant({
      'src/ui/Field.tsx': FIELD,
      'src/ui/field-styles.ts': [
        SEAM_IMPORT,
        'export const styles = { input: { fontSize: TEXT_INPUT_FONT_SIZE } }'
      ].join('\n'),
      ...SEAM_SOURCE,
      'src/platform/text-input-font-size.web.ts': 'export const TEXT_INPUT_FONT_SIZE = 16'
    })
    try {
      const closure = { local: ['src/ui/Field.tsx', 'src/ui/field-styles.ts'] }
      expect(textInputFontSizeOffenders(root, closure)).toEqual([])
      expect(unresolvedTextInputStyles(root, closure)).toEqual([])
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
