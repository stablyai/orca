import { resolve } from 'node:path'

// UMD relative requires cannot survive a self-contained bundle.
export const JSONC_PARSER_ESM_ALIAS = {
  'jsonc-parser': resolve(import.meta.dirname, '../../node_modules/jsonc-parser/lib/esm/main.js')
}
