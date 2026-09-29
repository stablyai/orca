import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from './test-support/census-source-files'

// Why: src/shared/rpc-contract/*-params.ts hold the host's zod schemas. Bundling one
// into the app would let client code call parse(), and requiredString is
// z.unknown().transform(...) — it coerces a non-string to '' instead of rejecting it,
// silently changing the bytes the phone puts on the wire. Types only, never values.
const mobileRoot = fileURLToPath(new URL('..', import.meta.url))
const contractRoot = resolve(mobileRoot, '..', 'src', 'shared', 'rpc-contract')
const scannedRoots = ['app', 'src'].map((directory) => join(mobileRoot, directory))
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx'])

function targetsContract(path: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) {
    return false
  }
  const resolved = resolve(path, '..', specifier)
  return resolved === contractRoot || resolved.startsWith(`${contractRoot}/`)
}

function parse(path: string, source: string): ts.SourceFile {
  const extension = extname(path)
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extension === '.tsx' || extension === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

// Returns the specifiers that would pull contract *values* into the bundle.
export function contractValueImports(path: string, source: string): string[] {
  const sourceFile = parse(path, source)
  const offenders: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (targetsContract(path, specifier)) {
        const clause = node.importClause
        const everyNamedIsType =
          clause?.isTypeOnly === true ||
          (clause?.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly))
        // A bare `import './x'` has no clause at all and still emits a require.
        if (!everyNamedIsType) {
          offenders.push(specifier)
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text
      if (targetsContract(path, specifier)) {
        const everyNamedIsType =
          node.isTypeOnly ||
          (node.exportClause !== undefined &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.every((element) => element.isTypeOnly))
        if (!everyNamedIsType) {
          offenders.push(specifier)
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isDynamic = callee.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      const argument = node.arguments[0]
      if (
        (isDynamic || isRequire) &&
        argument &&
        ts.isStringLiteral(argument) &&
        targetsContract(path, argument.text)
      ) {
        offenders.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return offenders
}

/**
 * Whether this file names the contract at all, through the compiler's own module scanner.
 *
 * The census walks every mobile source file, and on this tree that is 2,235 files and 11.3 MB;
 * exactly one of them reaches the contract. Parsing and walking the AST of the other 2,234 to learn
 * that is what put this case over its 5 s timeout under full-suite load, where it has the machine to
 * itself for none of the time it did alone.
 *
 * `preProcessFile` is the scanner behind `tsc`'s own dependency discovery: it reports every module
 * reference — `import`, `export ... from`, `require()` and dynamic `import()`, which is the same four
 * shapes the analyser below inspects — without building a tree. It is a sound filter and not a
 * substring search over the text: it decodes string escapes, so a specifier spelled
 * `'...\u002Dcontract/...'` is reported as the path it resolves to rather than missed. The case
 * below pins that, on the same shapes the analyser is pinned against.
 *
 * Over-approximating on purpose: a type-only import names the contract too, so it reaches the
 * analyser, which is the thing that decides.
 *
 * One shape the scanner does not report, so the filter cannot rest on it alone: a namespace
 * re-export. `export * as ns from '...'` and its `export type * as ns` form are absent from
 * `importedFiles`, while `export *`, `export { X } from`, and `import ns = require()` are all
 * there — so a file re-exporting the contract under a name was dropped before the analyser saw it,
 * which is the one shape the soundness case exists to catch. Anything holding that shape is handed
 * on as well. Counted over the 2,236 files this census reads: 1,005 carry an asterisk and so reach
 * the token scan, which costs 173 ms for all of them together, and none matches — including this
 * one, whose spellings below live inside template literals and are therefore template text rather
 * than tokens. No file in the tree holds the shape, so the widening hands the analyser nothing new.
 *
 * A text match for the contract path would be the other way to widen, and is the wrong one: the
 * escaped-specifier case is a real import whose text does not contain the directory name, so a
 * substring fence would miss it while looking thorough.
 */
/**
 * Whether the source holds `export * as`, with or without `type`: the shape `preProcessFile` omits.
 *
 * By token, because the tokens can be separated by anything. A block comment between `*` and `as`,
 * or a line comment splitting them across two lines, still leaves one namespace re-export — and a
 * text rule reads those characters while the language does not. The scanner skips trivia, which is
 * exactly the difference.
 *
 * The `*` pre-check is sound for this shape — the token is that literal character, so a source
 * without one cannot hold the sequence — and it keeps the scan off the 1,231 files that have no
 * asterisk anywhere. It is not a rarity filter: a block comment carries an asterisk, so most files
 * with any comment at all still reach the scan.
 */
function hasNamespaceReExport(source: string): boolean {
  if (!source.includes('*')) {
    return false
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source
  )
  // The scanner is not a standalone tokenizer: after a `${...}` substitution the closing brace has
  // to be re-scanned as a template token or everything after it is read as ordinary source, and the
  // rest of the file is tokenised wrongly. `preProcessFile` keeps this same stack for that reason.
  const openTemplates: ts.SyntaxKind[] = []
  // `export` -> optional `type` -> `*` -> `as`, restarting from any `export` that breaks it.
  let matched = 0
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.TemplateHead) {
      openTemplates.push(ts.SyntaxKind.TemplateHead)
      matched = 0
      continue
    }
    if (openTemplates.length > 0) {
      // Inside a substitution, which cannot hold this declaration; the work here is staying in step.
      if (token === ts.SyntaxKind.OpenBraceToken) {
        openTemplates.push(ts.SyntaxKind.OpenBraceToken)
      } else if (token === ts.SyntaxKind.CloseBraceToken) {
        if (openTemplates.at(-1) === ts.SyntaxKind.TemplateHead) {
          // A tail ends the template; a middle means another substitution follows.
          if (scanner.reScanTemplateToken(false) === ts.SyntaxKind.TemplateTail) {
            openTemplates.pop()
          }
        } else {
          openTemplates.pop()
        }
      }
      matched = 0
      continue
    }
    if (matched === 2 && token === ts.SyntaxKind.AsKeyword) {
      return true
    }
    if (matched === 1 && token === ts.SyntaxKind.AsteriskToken) {
      matched = 2
      continue
    }
    if (matched === 1 && token === ts.SyntaxKind.TypeKeyword) {
      continue
    }
    matched = token === ts.SyntaxKind.ExportKeyword ? 1 : 0
  }
  return false
}

function referencesContract(path: string, source: string): boolean {
  if (hasNamespaceReExport(source)) {
    return true
  }
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.some((reference) => targetsContract(path, reference.fileName))
}

/**
 * The contract imported under a specifier whose text does not spell it: `-` written `\u002D`.
 *
 * Built from character codes rather than a raw string literal, because a source file carrying the
 * escape is a source file whose own bytes the formatter, the linter and the next reader are all
 * entitled to normalise — and normalising it would quietly turn this into an ordinary specifier.
 */
const ESCAPED_SPECIFIER = `import { RepoSelector } from '../../src/shared/rpc${String.fromCharCode(
  92
)}u002Dcontract/repo-params'`

describe('RPC params contract boundary', () => {
  it('flags every shape that would emit a runtime require', () => {
    const path = join(mobileRoot, 'src', 'probe.ts')
    const contract = '../../src/shared/rpc-contract/repo-params'
    expect(contractValueImports(path, `import { RepoSelector } from '${contract}'`)).toEqual([
      contract
    ])
    expect(contractValueImports(path, `import '${contract}'`)).toEqual([contract])
    expect(contractValueImports(path, `export { RepoSelector } from '${contract}'`)).toEqual([
      contract
    ])
    expect(contractValueImports(path, `const s = require('${contract}')`)).toEqual([contract])
    expect(contractValueImports(path, `const s = await import('${contract}')`)).toEqual([contract])
    expect(contractValueImports(path, `import type { RepoSelector } from '${contract}'`)).toEqual(
      []
    )
    expect(contractValueImports(path, `import { type RepoSelector } from '${contract}'`)).toEqual(
      []
    )
    expect(contractValueImports(path, `export type { RepoSelector } from '${contract}'`)).toEqual(
      []
    )
    expect(
      contractValueImports(
        path,
        `import type { GitHubWorkItem } from '../../src/shared/github/work-item-types'`
      )
    ).toEqual([])
  })

  it('lets every contract import spelling the analyser flags reach it', () => {
    // The soundness half of the two-stage read below. The analyser only ever sees what this
    // predicate admits, so a narrowing here is a fence that stops fencing while staying green —
    // and it would stay green, because the tree has no offender to miss.
    const path = join(mobileRoot, 'src', 'probe.ts')
    const contract = '../../src/shared/rpc-contract/repo-params'
    const contractImportSpellings = [
      `import { RepoSelector } from '${contract}'`,
      `import '${contract}'`,
      `export { RepoSelector } from '${contract}'`,
      `const s = require('${contract}')`,
      `const s = await import('${contract}')`,
      // The type-only spellings too: this stage does not decide, it only hands work to the one
      // that does, and a filter that pre-judged them would hide a later edit that dropped `type`.
      `import type { RepoSelector } from '${contract}'`,
      `import { type RepoSelector } from '${contract}'`,
      `export type { RepoSelector } from '${contract}'`,
      // Namespace re-exports: the shape `ts.preProcessFile` does not report, so the pre-filter
      // dropped the file before the analyser ever saw it.
      `export * as ns from '${contract}'`,
      `export type * as ns from '${contract}'`,
      // And with trivia between the tokens, which is still one namespace re-export: a text rule
      // reads the characters between `*` and `as` and a token rule does not see them at all.
      `export * /* note */ as ns from '${contract}'`,
      `export *\n// note\nas ns from '${contract}'`,
      // And after an interpolated template, which is where a bare scanner loop loses its place.
      'const t = `a${1}b`\n' + `export * as ns from '${contract}'`,
      // A brace inside the substitution, and a template inside it: the two shapes that exercise
      // the stack rather than a single flag, which a lone substitution would leave unpinned.
      'const t = `a${ { k: 1 } }b`\n' + `export * as ns from '${contract}'`,
      'const t = `a${ `x${2}y` }b`\n' + `export * as ns from '${contract}'`,
      ESCAPED_SPECIFIER
    ]
    expect(contractImportSpellings.filter((source) => !referencesContract(path, source))).toEqual(
      []
    )
    // The escaped spelling's own premise, asserted rather than described: its text really does not
    // contain the directory name, so admitting it is the scanner decoding the specifier and not a
    // substring happening to match. A plain `includes` filter over the file would miss this one.
    expect(ESCAPED_SPECIFIER).not.toContain('rpc-contract')
    expect(referencesContract(path, ESCAPED_SPECIFIER)).toBe(true)
    // And it is not simply true of everything: an unrelated import is not handed on.
    expect(
      referencesContract(
        path,
        `import type { GitHubWorkItem } from '../../src/shared/github/work-item-types'`
      )
    ).toBe(false)
  })

  it('keeps every mobile import of the params contract type-only', () => {
    const sources = scannedRoots
      .flatMap(censusSourceFiles)
      .filter((path) => sourceExtensions.has(extname(path)))
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
    // The walk found the tree it is written against, rather than a directory that moved.
    expect(sources.length).toBeGreaterThan(1000)

    const reaching = sources.filter(({ path, source }) => referencesContract(path, source))
    // The presence precondition. `[]` below is the verdict "every reach is type-only", and without
    // this it is also what a census reaching nothing at all prints — a renamed contract directory,
    // a scanner that stopped reporting, a walk over the wrong root.
    expect(reaching.length).toBeGreaterThan(0)

    const offenders = reaching.flatMap(({ path, source }) =>
      contractValueImports(path, source).map(
        (specifier) => `${relative(mobileRoot, path)} -> ${specifier}`
      )
    )
    expect(offenders).toEqual([])
  })
})
