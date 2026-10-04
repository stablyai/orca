import { compileFunction } from 'node:vm'
import ts from 'typescript'

const compiled = new Map<string, ReturnType<typeof compileFunction>>()
const MAX_COMPILED_MODULES = 512

/** Only code is shared: each invocation receives a fresh require closure and exports object. */
export function compiledOperationModule(file: string, source: string, exposure: string) {
  const key = JSON.stringify([file, source, exposure])
  const cached = compiled.get(key)
  if (cached) {
    return cached
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
  if (compiled.size >= MAX_COMPILED_MODULES) {
    const oldest = compiled.keys().next().value
    if (oldest !== undefined) {
      compiled.delete(oldest)
    }
  }
  compiled.set(key, evaluate)
  return evaluate
}
