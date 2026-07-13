import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** grammarKey -> wasm filename inside @vscode/tree-sitter-wasm/wasm */
const WASM_FILES: Record<string, string> = {
  // language-config.ts maps both `typescript` and `javascript` language IDs to
  // grammarKey `tsx` (the tsx grammar parses .ts/.js/.jsx/.tsx), so there are 5
  // distinct grammar keys here — no plain `typescript` key is requested.
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm'
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
