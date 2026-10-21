import { createRequire } from 'node:module'
import type { Alias } from 'vite'

const require = createRequire(import.meta.url)

// Why: monaco-editor's `require` export condition is its AMD bundle, so a CommonJS dependency
// that requires it (monaco-emacs) would bundle a second Monaco that throws `define is not
// defined`. Pinning the bare specifier to the ESM entry keeps every importer on the one instance
// the app already loads; deep `monaco-editor/esm/...` imports don't match and stay untouched.
export const monacoEditorEsmAlias: Alias = {
  find: /^monaco-editor$/,
  replacement: require.resolve('monaco-editor/esm/vs/editor/editor.main.js')
}

/** Vite only accepts one alias shape, so fold an alias object and extra entries into the array form. */
export function toAliasList(aliases: Record<string, string>, ...extra: Alias[]): Alias[] {
  return [
    ...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
    ...extra
  ]
}
