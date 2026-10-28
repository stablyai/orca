import { createRequire } from 'node:module'
import type { Alias } from 'vite'

const require = createRequire(import.meta.url)

// monaco-editor's `require` condition is its AMD bundle, so CommonJS monaco-emacs would load a second Monaco (`define is not defined`).
export const monacoEditorEsmAlias: Alias = {
  find: /^monaco-editor$/,
  replacement: require.resolve('monaco-editor/esm/vs/editor/editor.main.js')
}

/** Vite accepts one alias shape, so fold objects and extra entries into the array form. */
export function toAliasList(aliases: Record<string, string>, ...extra: Alias[]): Alias[] {
  return [
    ...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
    ...extra
  ]
}
