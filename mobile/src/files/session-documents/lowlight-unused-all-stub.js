// Metro does not tree-shake lowlight's `export { grammars as all } from './lib/all.js'`.
// Mobile syntax highlighting only registers `common`, so omit the 155 unused highlight.js grammars.
export const grammars = {}
