import { compileFunction } from 'node:vm'
import ts from 'typescript-api'

type CompiledModule = {
  source: string
  evaluate: ReturnType<typeof compileFunction>
}

const compiled = new Map<string, Map<string, CompiledModule>>()
const insertionOrder = new Map<CompiledModule, string>()
const MAX_COMPILED_MODULES = 512

/** Only code is shared: each invocation receives a fresh require closure and exports object. */
export function compiledOperationModule(file: string, source: string, exposure: string) {
  const key = JSON.stringify([file, exposure])
  const cached = compiled.get(key)?.get(source)
  if (cached) {
    return cached.evaluate
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      // Product JSX uses the automatic runtime without importing React.
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  const evaluate = compileFunction(output + exposure, ['require', 'exports'], { filename: file })
  if (insertionOrder.size >= MAX_COMPILED_MODULES) {
    const oldest = insertionOrder.entries().next().value
    if (oldest !== undefined) {
      const [entry, variantKey] = oldest
      insertionOrder.delete(entry)
      const entries = compiled.get(variantKey)
      entries?.delete(entry.source)
      if (!entries?.size) {
        compiled.delete(variantKey)
      }
    }
  }
  const entry = { source, evaluate }
  const entries = compiled.get(key) ?? new Map<string, CompiledModule>()
  entries.set(source, entry)
  compiled.set(key, entries)
  insertionOrder.set(entry, key)
  return evaluate
}
