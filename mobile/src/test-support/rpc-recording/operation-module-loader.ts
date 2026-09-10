import { compileFunction } from 'node:vm'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as React from 'react'
import ts from 'typescript'
import { OPERATION_EXPOSURES, OPERATION_MUTATIONS, type Mutation } from './operation-mutations'

export type { Mutation }
export type OperationModule = Record<string, (...args: any[]) => unknown>

// Only mounting boundaries are substituted; every operation and projection is loaded from source.
export function operationModuleLoader(root: string, mutation?: Mutation) {
  const cache = new Map<string, OperationModule>()
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
    if (name === 'react') {
      return React
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
    const spec = mutation ? OPERATION_MUTATIONS[mutation] : undefined
    if (spec && file.endsWith(spec.file)) {
      // Counting occurrences, not replace calls: `replace` would silently take only the first.
      const occurrences = source.split(spec.before).length - 1
      if (occurrences !== 1) {
        throw new Error(`Mutant anchor matched ${occurrences} sites, expected 1: ${mutation}`)
      }
      source = source.replace(spec.before, spec.after)
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
    const exposure = OPERATION_EXPOSURES.find(([suffix]) => file.endsWith(suffix))?.[1] ?? ''
    const evaluate = compileFunction(output + exposure, ['require', 'exports'], { filename: file })
    evaluate((name: string) => imported(file, name), exports)
    return exports
  }
  return {
    load: <T = OperationModule>(path: string): T =>
      load(pathFor(resolve(root, path))) as unknown as T,
    assertMutationApplied: () => {
      if (mutation && mutationCount !== 1) {
        throw new Error(`Expected one mutation, applied ${mutationCount}`)
      }
    }
  }
}
