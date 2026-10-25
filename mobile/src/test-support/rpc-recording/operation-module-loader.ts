import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript-api'
import { nativeMountingSubstitutes } from './native-mounting-substitutes'
import { observeSalvagedReads } from './salvage-observation'
import * as deliveryAmbiguity from '../../transport/rpc-delivery-ambiguity'
import { compiledOperationModule } from './compiled-operation-module'

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

// Share delivery ambiguity’s WeakSet registry; evaluating another copy would turn marked unknown deliveries into definite failures.
const SHARED_MODULE = 'mobile/src/transport/rpc-delivery-ambiguity.ts'

// Only mounting boundaries are substituted; every operation and projection is loaded from source.
export function operationModuleLoader(
  root: string,
  mutation?: OperationMutation,
  exposures: readonly OperationExposure[] = [],
  /** What this recording declared about its device, overlaid on the refusing defaults. */
  declared: ReadonlyMap<string, unknown> = new Map()
) {
  const cache = new Map<string, OperationModule>()
  let natives: Map<string, unknown> | undefined
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
    // Most registered adapters are never mounted in this recording.
    natives ??= new Map([...nativeMountingSubstitutes(), ...declared])
    const native = natives.get(name)
    if (native !== undefined) {
      return native
    }
    if (!name.startsWith('.')) {
      return new Proxy(
        {},
        {
          // Preserve the import proxy through interop; refuse the first member actually read, including .default.
          get: (_target, key) => {
            if (key === '__esModule') {
              return true
            }
            throw new Error(`Unspecified native mounting dependency: ${name}.${String(key)}`)
          }
        }
      )
    }
    const file = pathFor(resolve(dirname(base), name))
    if (file === sharedModulePath) {
      return deliveryAmbiguity
    }
    return new Proxy(
      {},
      {
        get: (_target, key) => load(file)[String(key)],
        // CommonJS star reexports enumerate the imported module's own exports.
        ownKeys: () => Reflect.ownKeys(load(file)),
        getOwnPropertyDescriptor: (_target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(load(file), key)
          return descriptor && { ...descriptor, configurable: true }
        }
      }
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
                ) ||
                ts
                  .createSourceFile(target, text, ts.ScriptTarget.Latest, true)
                  .statements.some(
                    (entry) =>
                      ts.isExportDeclaration(entry) &&
                      !entry.isTypeOnly &&
                      entry.exportClause &&
                      ts.isNamedExports(entry.exportClause) &&
                      entry.exportClause.elements.some(
                        (binding) => binding.name.text === key && !binding.isTypeOnly
                      )
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
      // Require exactly one anchor occurrence; replace alone would silently ignore duplicates.
      const occurrences = source.split(mutation.before).length - 1
      if (occurrences !== 1) {
        throw new Error(`Mutant anchor matched ${occurrences} sites, expected 1: ${mutation.name}`)
      }
      source = source.replace(mutation.before, mutation.after)
      mutationCount++
    }
    const exports: OperationModule = {}
    cache.set(file, exports)
    const exposure = exposures.find(([suffix]) => file.endsWith(suffix))?.[1] ?? ''
    const evaluate = compiledOperationModule(file, source, exposure)
    evaluate((name: string) => imported(file, name), exports)
    observeSalvagedReads(file, exports)
    return exports
  }
  return {
    load: <T = OperationModule>(path: string): T =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a VM-evaluated module has no static type; the caller names the shape it mounts.
      load(pathFor(resolve(root, path))) as unknown as T,
    mutationsApplied: () => mutationCount
  }
}
