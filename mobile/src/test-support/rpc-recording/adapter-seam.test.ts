import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { adapterSourceByOperation } from './adapter-digest'
import { MOUNTED_OPERATION_MODULES } from './adapters/mounted-operation-modules'
import { operationModuleLoader } from './operation-module-loader'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { ADAPTER_DIRECTORY, RECORDER_DIRECTORY } from './recorder-digest'
import { readScenarios } from './scenario-input'

const root = resolve(import.meta.dirname, '../../../..')

const manifest = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
).scenarios

const engine = join(root, RECORDER_DIRECTORY)

const directory = join(root, ADAPTER_DIRECTORY)

/** The register is the seam's own index, not an adapter: no golden is recorded through it. */
const REGISTER = 'mounted-operation-modules.ts'

const registerPath = join(directory, REGISTER).replace(/\.ts$/, '')

const sources = MOUNTED_OPERATION_MODULES.map((module) => module.source)

/** Relative specifiers, resolved against the importing file's directory, extension dropped. */
function imports(from: string, contents: string): { specifier: string; target: string }[] {
  return [...contents.matchAll(/(?:from|import\()\s*'(\.[^']*)'/g)].map((match) => ({
    specifier: match[1]!,
    target: resolve(from, match[1]!).replace(/\.tsx?$/, '')
  }))
}

function read(source: string): string {
  return readFileSync(join(directory, source), 'utf8')
}

/** Every named import the register makes, local name to specifier. */
function registerImports(file: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>()

  for (const statement of file.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined

    if (!clause || clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier!)) {
      continue
    }

    const named = clause.namedBindings

    if (!named || !ts.isNamedImports(named)) {
      continue
    }

    for (const element of named.elements) {
      if (!element.isTypeOnly) {
        bindings.set(element.name.text, statement.moduleSpecifier.text)
      }
    }
  }

  return bindings
}

/** The registered entries as written, so a literal in the register is visible as a literal. */
function registerEntries(file: ts.SourceFile): ts.ObjectLiteralExpression[] {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue
    }

    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer

      if (
        declaration.name.getText() === 'MOUNTED_OPERATION_MODULES' &&
        initializer &&
        ts.isArrayLiteralExpression(initializer)
      ) {
        return initializer.elements.filter((element) => ts.isObjectLiteralExpression(element))
      }
    }
  }

  throw new Error('MOUNTED_OPERATION_MODULES is not an array literal in the register')
}

function property(entry: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of entry.properties) {
    if (ts.isPropertyAssignment(member) && member.name.getText() === name) {
      return member.initializer
    }
  }

  return undefined
}

/**
 * `recorderSha256` covers the engine and `adapterSha256` covers one module per golden, so a file on
 * the wrong side of this directory is pinned by the wrong thing — an engine file here escapes every
 * golden, and an adapter outside re-digests all of them. Both fail here on the move instead.
 */
describe('the engine/adapter seam', () => {
  it('registers every file in the adapter directory', () => {
    const present = readdirSync(directory).filter((file) => file !== REGISTER)
    expect(present.sort()).toEqual([...sources].sort())
  })

  it('pairs each registered module with the file that declares it', () => {
    expect(new Set(sources).size).toBe(sources.length)

    const unpaired = MOUNTED_OPERATION_MODULES.filter(
      ({ source, mounts }) => !read(source).includes(`export function ${mounts.name}(`)
    ).map(({ source, mounts }) => `${mounts.name} is not declared in ${source}`)

    expect(unpaired).toEqual([])
  })

  // An adapter reaching sideways would leave a golden pinned to one module and driven by two.
  // Resolved, not spelled: `../adapters/other` climbs out and back in, and reads as an escape.
  it('leaves the seam for every import an adapter module makes', () => {
    const inward = sources.flatMap((source) =>
      imports(directory, read(source))
        .filter(({ target }) => target.startsWith(`${directory}${sep}`))
        .map(({ specifier }) => `${source} imports ${specifier}`)
    )

    expect(inward).toEqual([])
  })

  /**
   * The same seam from the other side. `recorderSha256` skips this directory and `adapterSha256`
   * names one module per golden, so an engine file that imports an adapter executes code that
   * every golden recorded through a different domain leaves out of its header. Only the register
   * may be crossed to, because it is the one file here that carries nothing of its own.
   */
  it('reaches the adapter directory only through the register, from every engine file', () => {
    const crossings = readdirSync(engine, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .flatMap((entry) =>
        imports(engine, readFileSync(join(engine, entry.name), 'utf8'))
          .filter(
            ({ target }) => target.startsWith(`${directory}${sep}`) && target !== registerPath
          )
          .map(({ specifier }) => `${entry.name} imports ${specifier}`)
      )

    expect(crossings).toEqual([])
  })

  /**
   * The register is pinned by nothing: the engine digest skips this directory and `adapterSha256`
   * reads each entry's `source`, never the register. That is only sound while the register is an
   * index — a `mounts` or `exposes` written inline here would drive a recording that no digest
   * covers. Both must be identifiers imported from the entry's own module, so whatever they carry
   * lives in the file that golden already pins.
   */
  it("carries no behaviour of its own, only bindings from each entry's module", () => {
    const file = ts.createSourceFile(REGISTER, read(REGISTER), ts.ScriptTarget.Latest, true)
    const bindings = registerImports(file)
    const entries = registerEntries(file)
    expect(entries.length).toBe(MOUNTED_OPERATION_MODULES.length)

    const carried = entries.flatMap((entry) => {
      const source = property(entry, 'source')

      if (!source || !ts.isStringLiteral(source)) {
        return ['an entry declares no literal source']
      }

      const expected = `./${source.text.replace(/\.ts$/, '')}`

      return ['mounts', 'exposes'].flatMap((field) => {
        const value = property(entry, field)

        if (!value) {
          return field === 'mounts' ? [`${source.text} registers no mounts`] : []
        }

        if (!ts.isIdentifier(value)) {
          return [`${source.text} writes ${field} inline instead of importing it`]
        }

        const from = bindings.get(value.text)

        return from === expected
          ? []
          : [`${source.text} takes ${field} from ${from ?? 'no import'}`]
      })
    })

    expect(carried).toEqual([])
  })

  it('mounts nothing outside a registered module', () => {
    const modules = operationModuleLoader(root)

    const registered = MOUNTED_OPERATION_MODULES.flatMap((module) =>
      Object.keys(module.mounts(modules, {}))
    )

    expect(Object.keys(pilotMountAdapters(root).adapters).sort()).toEqual([...registered].sort())
  })

  it('attributes every recorded operation to a registered module', () => {
    const owners = adapterSourceByOperation(root)

    const orphans = [...new Set(manifest.map((scenario) => scenario.operation))]
      .filter((operation) => !owners.has(operation))
      .sort()

    expect(orphans).toEqual([])
  })
})
