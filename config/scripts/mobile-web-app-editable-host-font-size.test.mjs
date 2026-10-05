/**
 * The editable-host rule, over the tree it ships against and over fixtures of its own.
 *
 * Two halves, because an offender list is only evidence when the walk read something. The first
 * runs the rule over the rich Markdown editor's real modules and says which line carries the size;
 * the second drives the readings the real tree does not have — a size below the floor, a name that
 * merely spells the seam's, an editable with no id — against a fixture tree whose only reason to
 * exist is that those readings have to be observable somewhere.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  editableHostFontSizeOffenders,
  editableHostsIn,
  unresolvedEditableHostStyles
} from './mobile-web-app-editable-host-font-size.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))

/** The editor's own two modules, as a closure naming nothing else. */
const EDITOR_CLOSURE = {
  local: [
    'src/components/rich-markdown/document-markup.ts',
    'src/components/rich-markdown/document-style.ts'
  ]
}

/** The seam's web half, copied into a fixture tree so the floor is read rather than restated. */
const SEAM_SOURCE = `export const TEXT_INPUT_FONT_SIZE_FLOOR = 16\n`

let fixtureDir = null

/** A fixture tree with the seam in it, plus whatever markup and stylesheet a case needs. */
async function fixture(name, markup, style) {
  const root = join(fixtureDir, name)
  await mkdir(join(root, 'src/platform'), { recursive: true })
  await mkdir(join(root, 'src/doc'), { recursive: true })
  await writeFile(join(root, 'src/platform/text-input-font-size.web.ts'), SEAM_SOURCE, 'utf8')
  await writeFile(join(root, 'src/doc/markup.ts'), markup, 'utf8')
  await writeFile(join(root, 'src/doc/style.ts'), style, 'utf8')
  return { root, closure: { local: ['src/doc/markup.ts', 'src/doc/style.ts'] } }
}

/** The same tree with a second stylesheet one directory down, and a closure that reads it first. */
async function fixtureWithNested(name, markup, style, nestedStyle) {
  const { root } = await fixture(name, markup, style)
  await mkdir(join(root, 'src/doc/nested'), { recursive: true })
  await writeFile(join(root, 'src/doc/nested/style.ts'), nestedStyle, 'utf8')
  return {
    root,
    // Nested first, which is what makes this a measurement: the closure's order is the bundler's,
    // so a walk that accepted any file under the directory would stop here.
    closure: { local: ['src/doc/nested/style.ts', 'src/doc/markup.ts', 'src/doc/style.ts'] }
  }
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'orca-editable-host-'))
})

afterAll(async () => {
  if (fixtureDir) {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})

describe('the editable-host font-size rule', () => {
  it('finds the editor the TextInput census cannot see', () => {
    // The precondition every verdict below needs: this walk reads the editor's real markup and
    // names the surface the page mounts.
    expect(editableHostsIn(mobileDir, EDITOR_CLOSURE)).toEqual([
      { file: 'src/components/rich-markdown/document-markup.ts', id: 'editor' }
    ])
  })

  it('follows the surface to the rule in the stylesheet beside it', () => {
    expect(unresolvedEditableHostStyles(mobileDir, EDITOR_CLOSURE)).toEqual([])
    expect(editableHostFontSizeOffenders(mobileDir, EDITOR_CLOSURE)).toEqual([])
  })

  it('reds on an editable under the floor', async () => {
    const { root, closure } = await fixture(
      'under',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 14px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(root, closure)).toEqual(['src/doc/style.ts:2'])
  })

  it('accepts a literal that already clears the floor, and a size read from the seam', async () => {
    const literal = await fixture(
      'literal',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(literal.root, literal.closure)).toEqual([])

    const bound = await fixture(
      'bound',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      "import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'\n" +
        'export function style() {\n  return `    #editor {\n      font-size: ${TEXT_INPUT_FONT_SIZE}px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(bound.root, bound.closure)).toEqual([])
  })

  it('refuses a name that only spells the seam’s', async () => {
    // A local `const TEXT_INPUT_FONT_SIZE = 14` two lines up is exactly the regression the seam
    // exists to stop, wearing its name.
    const { root, closure } = await fixture(
      'local',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'const TEXT_INPUT_FONT_SIZE = 14\n' +
        'export function style() {\n  return `    #editor {\n      font-size: ${TEXT_INPUT_FONT_SIZE}px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(root, closure)).toEqual(['src/doc/style.ts:3'])
  })

  it('counts a no-id editable beside a named one, rather than only the named one', async () => {
    // The tag is what an editable is, and its id is optional: a walk that started from the id
    // matched the named host and never saw the one beside it, so a file holding both reported the
    // named one as clean and said nothing at all about the other.
    const { root, closure } = await fixture(
      'mixed',
      'export const NAMED = \'<main id="editor" contenteditable="true"></main>\'\n' +
        'export const ANONYMOUS = \'<section contenteditable="true"></section>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }`\n}\n'
    )
    expect(editableHostsIn(root, closure)).toEqual([
      { file: 'src/doc/markup.ts', id: 'editor' },
      { file: 'src/doc/markup.ts', id: null }
    ])
    expect(unresolvedEditableHostStyles(root, closure)).toEqual(['src/doc/markup.ts'])
  })

  it('reads the sheet beside the markup, not one a directory down', async () => {
    // The walk stops at the first file whose sheet opens `#editor`, and the closure's order is the
    // bundler's rather than alphabetical, so a nested sheet could answer for a sibling that is the
    // one the host actually gets.
    const { root, closure } = await fixtureWithNested(
      'nested',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 14px;\n    }`\n}\n',
      'export function nested() {\n  return `    #editor {\n      font-size: 18px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(root, closure)).toEqual(['src/doc/style.ts:2'])
  })

  it('reports an editable it cannot judge rather than passing it', async () => {
    const noId = await fixture(
      'no-id',
      'export const MARKUP = \'<main contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    main { font-size: 18px; }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(noId.root, noId.closure)).toEqual(['src/doc/markup.ts'])
    expect(editableHostFontSizeOffenders(noId.root, noId.closure)).toEqual([])

    const noRule = await fixture(
      'no-rule',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    main { font-size: 18px; }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(noRule.root, noRule.closure)).toEqual([
      'src/doc/markup.ts (#editor)'
    ])
  })

  it('reads the declaration CSS uses, not the first one in the rule', async () => {
    // Equal importance, so the last one wins. A walk that stopped at the first read 16 px and
    // called a 14 px surface compliant.
    const { root, closure } = await fixture(
      'repeated',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 16px;\n' +
        '      font-size: 14px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(root, closure)).toEqual(['src/doc/style.ts:2'])
  })

  it('lets an important declaration outrank a later one, as the cascade does', async () => {
    const important = await fixture(
      'important-wins',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px !important;\n' +
        '      font-size: 14px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(important.root, important.closure)).toEqual([])

    // And an important declaration is still read as the size it sets, rather than as a shape the
    // walk does not model: without stripping the flag, a compliant `!important` size on the seam
    // would have been reported as an offender.
    const offending = await fixture(
      'important-offends',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 14px !important;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(offending.root, offending.closure)).toEqual([
      'src/doc/style.ts:2'
    ])
  })

  it('cannot judge an editable that declares no size, and says so', async () => {
    // Inheritance is not a pass here. The value would come from a rule in a file this walk does not
    // read — the host element's own, or the page's root — so "no declaration" is "cannot say" and
    // belongs in the unresolved list, which the closure census holds at empty.
    const { root, closure } = await fixture(
      'inherits',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      padding: 8px;\n    }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(root, closure)).toEqual(['src/doc/style.ts:2'])
    // Not an offender either: an offender is a size this walk read and found under the floor.
    expect(editableHostFontSizeOffenders(root, closure)).toEqual([])
  })

  it('reads every exact rule in the sheet, in source order, as the cascade does', async () => {
    // Equal specificity, so the last rule wins. Reading only the first called a 14 px surface
    // compliant because a compliant rule happened to sit above it.
    const later = await fixture(
      'later-exact',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }\n' +
        '    #editor {\n      font-size: 14px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(later.root, later.closure)).toEqual(['src/doc/style.ts:2'])
  })

  it('takes source order rather than the lowest exact rule in the sheet', async () => {
    // The control the reading above needs: the same two rules the other way round are compliant,
    // so the verdict is the cascade rather than "any rule under the floor anywhere in the sheet".
    const earlier = await fixture(
      'earlier-exact',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 14px;\n    }\n' +
        '    #editor {\n      font-size: 18px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(earlier.root, earlier.closure)).toEqual([])
  })

  it('cannot rank a higher-specificity subject rule, and says so rather than passing', async () => {
    // `main#editor` outranks `#editor` and this census does no specificity arithmetic, so a rule
    // like it declaring a size is a hole, named at its own line.
    const { root, closure } = await fixture(
      'subject-specificity',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }\n' +
        '    main#editor {\n      font-size: 14px;\n    }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(root, closure)).toEqual(['src/doc/style.ts:5'])
    // Not an offender either: an offender is a size this walk read and could rank.
    expect(editableHostFontSizeOffenders(root, closure)).toEqual([])
  })

  it('splits a selector list, so a host riding in one still reaches the verdict', async () => {
    const { root, closure } = await fixture(
      'subject-in-list',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }\n' +
        '    h1, main#editor {\n      font-size: 14px;\n    }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(root, closure)).toEqual(['src/doc/style.ts:5'])
  })

  it('reads the host’s own id, not a longer one that starts with it', async () => {
    // The selector list is now read whole, so `#editor` has to stop at an id boundary: without one,
    // a rule for the element beside the host would have made the host unresolved.
    const { root, closure } = await fixture(
      'neighbour-id',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }\n' +
        '    #editor-notes {\n      font-size: 14px;\n    }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(root, closure)).toEqual([])
    expect(editableHostFontSizeOffenders(root, closure)).toEqual([])
  })

  it('leaves a descendant rule and a pseudo-element rule out of the way', async () => {
    // Neither one is the host: `#editor p` is about another element, and `::before` is a box the
    // host generates. Counting either as a hole would report the shipped sheet unresolved.
    const { root, closure } = await fixture(
      'not-the-host',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }\n' +
        '    #editor::before {\n      font-size: 12px;\n    }\n' +
        '    #editor p {\n      font-size: 0.9em;\n    }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(root, closure)).toEqual([])
    expect(editableHostFontSizeOffenders(root, closure)).toEqual([])
  })
})
