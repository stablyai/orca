import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** grammarKey -> wasm filename inside @vscode/tree-sitter-wasm/wasm */
const WASM_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm'
  // Note: all six grammars needed by language-config.ts's CONFIGS are present
  // in @vscode/tree-sitter-wasm@0.3.1's wasm/ directory, so none were dropped.
}

let wasmDir: string | null = null

function resolveWasmDir(): string {
  if (wasmDir) {
    return wasmDir
  }
  const pkgJson = require.resolve('@vscode/tree-sitter-wasm/package.json')
  wasmDir = path.join(path.dirname(pkgJson), 'wasm')
  return wasmDir
}

export function grammarWasmPath(grammarKey: string): string | null {
  const file = WASM_FILES[grammarKey]
  if (!file) {
    return null
  }
  return path.join(resolveWasmDir(), file)
}

/**
 * Path to the web-tree-sitter runtime wasm.
 *
 * Note: web-tree-sitter@0.26.x's package.json `exports` map only publishes
 * the runtime wasm at the subpath `web-tree-sitter.wasm` (there is no
 * `tree-sitter.wasm` file in this version) — verified via
 * `require.resolve('web-tree-sitter/web-tree-sitter.wasm')`.
 */
export function runtimeWasmPath(): string {
  return require.resolve('web-tree-sitter/web-tree-sitter.wasm')
}
