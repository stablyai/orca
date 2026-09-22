import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript-api'

const SRC = join(import.meta.dirname, '..')

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readFileSync(join(SRC, relativePath), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

/** Every JSX element in a module, in order, by tag name. Occurrences and not a set: the sheets
 *  file opens eight components across sixteen sheets. */
function rendered(source: ts.SourceFile): string[] {
  const tags: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName
      if (ts.isIdentifier(tag)) {
        tags.push(tag.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return tags
}

/** Which module each imported name came from, so a rendered tag can be followed to its file. */
function importedFrom(source: ts.SourceFile): Map<string, string> {
  const sources = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) {
      continue
    }
    const specifier = statement.moduleSpecifier
    const bindings = statement.importClause?.namedBindings
    if (!ts.isStringLiteral(specifier) || bindings === undefined || !ts.isNamedImports(bindings)) {
      continue
    }
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        sources.set(element.name.text, specifier.text)
      }
    }
  }
  return sources
}

/** A relative specifier as a path under `src`, or null for a package and for a file that is not
 *  there. Only relative imports are followed: nothing in `node_modules` renders this drawer. */
function resolve(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }
  const joined = join(dirname(fromFile), specifier)
  for (const extension of ['.tsx', '.ts']) {
    try {
      readFileSync(join(SRC, `${joined}${extension}`))
      return `${joined}${extension}`
    } catch {
      continue
    }
  }
  return null
}

const DRAWER_SEAM = 'MountedBottomDrawer'
const BACK_CLAIM_SEAM = 'useBackClaim'

/** Whether this module renders the drawer, directly or through the components it renders. */
function reachesDrawer(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) {
    return false
  }
  seen.add(file)
  const source = parse(file)
  const tags = rendered(source)
  if (tags.includes(DRAWER_SEAM)) {
    return true
  }
  const imports = importedFrom(source)
  return tags.some((tag) => {
    const specifier = imports.get(tag)
    if (specifier === undefined) {
      return false
    }
    const next = resolve(file, specifier)
    return next !== null && reachesDrawer(next, seen)
  })
}

/** The two modules that claim the key, which is the whole of the drawer stack's Back behaviour. */
const SEAM_MODULES = ['components/mounted-bottom-drawer.tsx', 'components/RightDrawer.tsx']

/**
 * Every sheet the session route opens goes through one Back seam.
 *
 * The defect this lane fixes was one press closing the whole screen with a sheet open, and the fix
 * is a single claim inside `MountedBottomDrawer`. That only covers all sixteen sheets while every
 * one of them still renders through it — a sheet that grew a `Modal` of its own would be back to
 * the old behaviour with nothing failing, because its own tests never press the key.
 */
describe('the session sheets and the device Back key', () => {
  const sheetsFile = 'session/MobileSessionSheets.tsx'
  const sheets = parse(sheetsFile)
  const imports = importedFrom(sheets)
  const opened = rendered(sheets).filter((tag) => imports.has(tag))

  it('opens the sheets this census is written against, so an empty finding means something', () => {
    // Sixteen at the time of writing, across eight components. The floor is what keeps a refactor
    // that collapsed the list from reporting a clean sweep over two sheets.
    expect(opened.length).toBeGreaterThanOrEqual(16)
    expect(opened).toContain('MobileDictationSetupSheet')
    expect(opened).toContain('ActionSheetModal')
  })

  it('renders every one of them through the drawer that holds the claim', () => {
    const offenders = [...new Set(opened)]
      .map((tag) => ({ tag, file: resolve(sheetsFile, imports.get(tag) ?? '') }))
      .filter((entry) => entry.file === null || !reachesDrawer(entry.file))
      .map((entry) => entry.tag)
    expect(offenders).toEqual([])
  })

  it('claims the key in those seams and reaches for no native key itself', () => {
    for (const file of SEAM_MODULES) {
      const source = readFileSync(join(SRC, file), 'utf8')
      expect(source, file).toContain(BACK_CLAIM_SEAM)
      // The seam is what decides the platform. A component reaching for the key itself is the web
      // half going missing again, which is exactly the shape the defect had.
      expect(source, file).not.toContain('BackHandler')
    }
  })
})
