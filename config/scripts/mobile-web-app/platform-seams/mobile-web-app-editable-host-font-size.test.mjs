// Require real editor hosts and drive below-floor, fake-seam and anonymous-host controls; empty offender list alone cannot prove census read anything.
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

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

const EDITOR_CLOSURE = {
  local: [
    'src/components/rich-markdown/document-markup.ts',
    'src/components/rich-markdown/document-style.ts'
  ]
}

// Copy web seam so fixture reads real floor instead of restating it.
const SEAM_SOURCE = `export const TEXT_INPUT_FONT_SIZE_FLOOR = 16\n`

let fixtureDir = null

async function fixture(name, markup, style) {
  const root = join(fixtureDir, name)
  await mkdir(join(root, 'src/platform'), { recursive: true })
  await mkdir(join(root, 'src/doc'), { recursive: true })
  await writeFile(join(root, 'src/platform/text-input-font-size.web.ts'), SEAM_SOURCE, 'utf8')
  await writeFile(join(root, 'src/doc/markup.ts'), markup, 'utf8')
  await writeFile(join(root, 'src/doc/style.ts'), style, 'utf8')
  return { root, closure: { local: ['src/doc/markup.ts', 'src/doc/style.ts'] } }
}

async function fixtureWithNested(name, markup, style, nestedStyle) {
  const { root } = await fixture(name, markup, style)
  await mkdir(join(root, 'src/doc/nested'), { recursive: true })
  await writeFile(join(root, 'src/doc/nested/style.ts'), nestedStyle, 'utf8')
  return {
    root,
    // Read nested sheet first to expose scans that wrongly accept any descendant directory.
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
    // Require census names real editor surface before interpreting empty offender list.
    expect(editableHostsIn(mobileDir, EDITOR_CLOSURE)).toContainEqual({
      file: 'src/components/rich-markdown/document-markup.ts',
      id: 'editor'
    })
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
    // Same-spelled local 14px constant must not impersonate seam import.
    const { root, closure } = await fixture(
      'local',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'const TEXT_INPUT_FONT_SIZE = 14\n' +
        'export function style() {\n  return `    #editor {\n      font-size: ${TEXT_INPUT_FONT_SIZE}px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(root, closure)).toEqual(['src/doc/style.ts:3'])
  })

  it('counts a no-id editable beside a named one, rather than only the named one', async () => {
    // Require anonymous host reported even beside compliant named host; id-first matching silently missed it.
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
    // Nested sheet ordered first must not answer for sibling stylesheet actually applied to host.
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
    // Last equal-importance declaration wins; first-safe lookup falsely approved 14px surface.
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

    // Strip important flag so compliant seam value is recognized.
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
    // Absent declaration inherits unknown external value; require unresolved, never clean.
    const { root, closure } = await fixture(
      'inherits',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      padding: 8px;\n    }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(root, closure)).toEqual(['src/doc/style.ts:2'])
    // Unknown value is unresolved, not a measured below-floor offender.
    expect(editableHostFontSizeOffenders(root, closure)).toEqual([])
  })

  it('reads every exact rule in the sheet, in source order, as the cascade does', async () => {
    // Last equal-specificity rule wins; earlier compliant rule cannot clear later 14px override.
    const later = await fixture(
      'later-exact',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }\n' +
        '    #editor {\n      font-size: 14px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(later.root, later.closure)).toEqual(['src/doc/style.ts:2'])
  })

  it('takes source order rather than the lowest exact rule in the sheet', async () => {
    // Reversed-rule positive control proves cascade, rather than rejecting any sheet containing low value.
    const earlier = await fixture(
      'earlier-exact',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 14px;\n    }\n' +
        '    #editor {\n      font-size: 18px;\n    }`\n}\n'
    )
    expect(editableHostFontSizeOffenders(earlier.root, earlier.closure)).toEqual([])
  })

  it('cannot rank a higher-specificity subject rule, and says so rather than passing', async () => {
    // More-specific main#editor outranks exact ID rule; report unresolved at unrankable selector line.
    const { root, closure } = await fixture(
      'subject-specificity',
      'export const MARKUP = \'<main id="editor" contenteditable="true"></main>\'\n',
      'export function style() {\n  return `    #editor {\n      font-size: 18px;\n    }\n' +
        '    main#editor {\n      font-size: 14px;\n    }`\n}\n'
    )
    expect(unresolvedEditableHostStyles(root, closure)).toEqual(['src/doc/style.ts:5'])
    // Unrankable size is unresolved, not a ranked below-floor offender.
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
    // ID boundary prevents neighboring #editor-notes from invalidating #editor.
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
    // Descendants/pseudo-elements target other boxes and must not make shipped host stylesheet unresolved.
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
