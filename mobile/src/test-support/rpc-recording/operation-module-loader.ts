import * as deliveryAmbiguity from '../../transport/rpc-delivery-ambiguity'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as React from 'react'
import ts from 'typescript'

export type Mutation = 'acceptance' | 'order' | 'race'
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
    // The operation and scripted transport must share the real WeakSet error identity.
    if (file.endsWith('rpc-delivery-ambiguity.ts')) {
      return deliveryAmbiguity as unknown as OperationModule
    }
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
    const replace = (before: string, after: string) => {
      if (!source.includes(before)) {
        throw new Error(`Mutant no longer applies: ${mutation}`)
      }
      source = source.replace(before, after)
      mutationCount++
    }
    if (mutation === 'race' && file.endsWith('use-mobile-native-chat-file-search.ts')) {
      replace('!response.ok || generationRef.current !== generation', '!response.ok')
    }
    if (
      mutation === 'acceptance' &&
      file.endsWith('use-mobile-tasks-project-metadata-actions.tsx')
    ) {
      replace('if (result.ok === false)', 'if (result?.ok === false)')
    }
    if (mutation === 'order' && file.endsWith('use-mobile-tasks-item-detail-loading.tsx')) {
      replace(
        "{ timeoutMs: 30_000 }\n        ),\n        client.sendRequest(\n          'linear.issueComments'",
        "{ timeoutMs: 30_000 }\n        ).then((response) => { if (!isSuccess(response)) throw new Error(response.error.message); return response }),\n        client.sendRequest(\n          'linear.issueComments'"
      )
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
    const exposed = file.endsWith('MobileAgentSessionHistoryPanel.tsx')
      ? '\nexports.loadMobileResumeMetadata = loadMobileResumeMetadata;'
      : ''
    const evaluate = new Function('require', 'exports', output + exposed)
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
