import { compileFunction } from 'node:vm'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { nativeMountingSubstitutes } from './native-mounting-substitutes'
import * as deliveryAmbiguity from '../../transport/rpc-delivery-ambiguity'

export type OperationModule = Record<string, (...args: any[]) => unknown>
/** One anchored in-memory source edit, resolved by the caller so the loader needs no mutant table. */
export type OperationMutation = {
  name: string
  /** Suffix of the mounted source file the anchor belongs to. */
  file: string
  before: string
  after: string
}
/** Source appended to a mounted module after transpile, keyed by the file suffix it applies to. */
export type OperationExposure = readonly [suffix: string, source: string]

// Why shared rather than evaluated: the delivery-unknown mark is a WeakSet keyed on the rejection
// object, so a second copy of the module has a second, empty registry and every marked rejection
// reads as a definite failure inside the mounted operation. Same reason React is shared.
const SHARED_MODULE = 'mobile/src/transport/rpc-delivery-ambiguity.ts'

// Only mounting boundaries are substituted; every operation and projection is loaded from source.
export function operationModuleLoader(
  root: string,
  mutation?: OperationMutation,
  exposures: readonly OperationExposure[] = []
) {
  const cache = new Map<string, OperationModule>()
  const natives = nativeMountingSubstitutes()
  const sharedModulePath = resolve(root, SHARED_MODULE)
  let mutationCount = 0
  function pathFor(base: string): string {
    const file = ['', '.ts', '.tsx', '/index.ts']
      .map((suffix) => base + suffix)
      .find((path) => existsSync(path) && /\.tsx?$/.test(path))
    if (!file) {
      throw new Error(`Module not found: ${base}`)
    }
    return file
  }
  function imported(base: string, name: string): unknown {
    const native = natives.get(name)
    if (native !== undefined) {
      return native
    }
    if (name.startsWith('.') && pathFor(resolve(dirname(base), name)) === sharedModulePath) {
      return deliveryAmbiguity
    }
    if (!name.startsWith('.')) {
      return new Proxy(
        {},
        {
          get: () => {
            throw new Error(`Unspecified native mounting dependency: ${name}`)
          }
        }
      )
    }
    return new Proxy(
      {},
      { get: (_target, key) => load(pathFor(resolve(dirname(base), name)))[String(key)] }
    )
  }
  function barrel(file: string, source: string): OperationModule {
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    return new Proxy(
      {},
      {
        get: (_target, key) => {
          for (const statement of parsed.statements) {
            if (
              !ts.isExportDeclaration(statement) ||
              !statement.moduleSpecifier ||
              !ts.isStringLiteral(statement.moduleSpecifier) ||
              statement.isTypeOnly
            ) {
              continue
            }
            const name = statement.moduleSpecifier.text
            if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
              const binding = statement.exportClause.elements.find(
                (item) => item.name.text === key && !item.isTypeOnly
              )
              if (binding) {
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the barrel target is a module this loader evaluated.
                return (imported(file, name) as OperationModule)[
                  binding.propertyName?.text ?? String(key)
                ]
              }
            } else if (!statement.exportClause) {
              const target = pathFor(resolve(dirname(file), name))
              const text = readFileSync(target, 'utf8')
              if (
                new RegExp(`export (?:async )?(?:function|const|class) ${String(key)}\\b`).test(
                  text
                )
              ) {
                return load(target)[String(key)]
              }
            }
          }
          throw new Error(`Unmapped barrel export: ${String(key)} in ${file}`)
        }
      }
    )
  }
  function load(file: string): OperationModule {
    const cached = cache.get(file)
    if (cached) {
      return cached
    }
    let source = readFileSync(file, 'utf8')
    if (/mobile-tasks-(dependencies|legacy-foundation)\.tsx?$/.test(file)) {
      const result = barrel(file, source)
      cache.set(file, result)
      return result
    }
    if (mutation && file.endsWith(mutation.file)) {
      // Counting occurrences, not replace calls: `replace` would silently take only the first.
      const occurrences = source.split(mutation.before).length - 1
      if (occurrences !== 1) {
        throw new Error(`Mutant anchor matched ${occurrences} sites, expected 1: ${mutation.name}`)
      }
      source = source.replace(mutation.before, mutation.after)
      mutationCount++
    }
    const exports: OperationModule = {}
    cache.set(file, exports)
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React
      }
    }).outputText
    const exposure = exposures.find(([suffix]) => file.endsWith(suffix))?.[1] ?? ''
    const evaluate = compileFunction(output + exposure, ['require', 'exports'], { filename: file })
    evaluate((name: string) => imported(file, name), exports)
    return exports
  }
  return {
    load: <T = OperationModule>(path: string): T =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a VM-evaluated module has no static type; the caller names the shape it mounts.
      load(pathFor(resolve(root, path))) as unknown as T,
    mutationsApplied: () => mutationCount
  }
}
