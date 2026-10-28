// One input below 16px focus-zooms whole iOS page; keyboard-occlusion intentionally rejects zoomed geometry, disabling commit/note lift everywhere.
// Census all closure inputs: raising only seam-served fields once left eight other 14px inputs capable of breaking page.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  TEXT_INPUT_FONT_SIZE_SEAM,
  textInputFontSizeFloor,
  textInputFontSizeOffenders,
  unresolvedTextInputStyles
} from './platform-seams/mobile-web-app-text-input-font-size-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const HUB = 'app/h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW = 'app/h/[hostId]/review/[worktreeId].tsx'

const SEAM_SOURCE = {
  'src/platform/text-input-font-size.ts': 'export const TEXT_INPUT_FONT_SIZE = 14'
}

// Seed seam web module: census reads its floor and refuses trees without it; refusal control overwrites seed.
const FLOOR_SOURCE = {
  'src/platform/text-input-font-size.web.ts': [
    'export const TEXT_INPUT_FONT_SIZE_FLOOR = 16',
    'export const TEXT_INPUT_FONT_SIZE = 16'
  ].join('\n')
}
const SEAM_IMPORT = "import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'"

// Isolate planted offenders from other censuses’ source trees.
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

  it('reads a themed stylesheet the way it reads StyleSheet.create', () => {
    const root = plant({
      'src/ui/Field.tsx': [
        "import { styles } from './field-styles'",
        'export const Field = () => <TextInput style={styles.input} />'
      ].join('\n'),
      'src/ui/field-styles.ts': [
        'export const styles = themedStyleSheet(() => ({',
        '  input: { fontSize: 14 }',
        '}))'
      ].join('\n')
    })
    try {
      const closure = { local: ['src/ui/Field.tsx', 'src/ui/field-styles.ts'] }
      expect(textInputFontSizeOffenders(root, closure)).toEqual(['src/ui/field-styles.ts:2'])
      expect(unresolvedTextInputStyles(root, closure)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('follows a spread into the module that really holds the key', () => {
    // Follow spread styles across modules; stopping at first import would miss actual screens’ {...base,...list} sizes.
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
    // Surface unresolved styles; zero offenders proves nothing if some inputs were never read.
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
    // Absent fontSize inherits; census judges declared input sizes.
    const root = plant({
      'src/ui/Field.tsx': [
        "import { styles } from './field-styles'",
        'export const Field = () => <TextInput style={styles.input} />',
        'export const Other = () => <TextInput style={styles.bare} />'
      ].join('\n'),
      // Require actual seam binding; same-spelled local name must remain offender.
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
    // Inline fontSize has no style key; styles.key-only walk silently misses it.
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
    // Follow style arrays and && right operand used by real inputs.
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

  // Test below/at/above floor: high-only control could pass if census ignored literals; boundary catches off-by-one.
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

  // Seed floor 20 and size 18 to distinguish source-derived floor from hardcoded 16.
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
    // Later spread overrides direct safe input at runtime; direct-key-first lookup falsely clears it.
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

// Follow .web siblings as bundler does; both good-native/bad-web and reverse controls catch wrong-platform verdicts.
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

  // Seam itself has web sibling raising native body size; resolving it must preserve recognized seam binding.
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
      // Require reachable inputs so empty closure cannot pass floor census.
      const closure = await mobileWebAppRouteClosure(route)
      expect(closure.local).toContain(TEXT_INPUT_FONT_SIZE_SEAM)
    })
  },
  240_000
)
