import type { Plugin } from 'vite'

/** Sucrase transformers plugin frames never enable; each embeds a bare `require('…')` as code text. */
const UNUSED_TRANSFORMERS = /^\.\/(?:FlowTransformer|ReactHotLoaderTransformer)(?:\.js)?$/
const SUCRASE_TRANSFORMERS_DIR =
  /[\\/]node_modules[\\/]sucrase[\\/]dist[\\/](?:esm[\\/])?transformers[\\/]/
const STUB_ID = '\0orca-sucrase-unused-transformer'

export const SUCRASE_UNUSED_TRANSFORMER_STUB =
  "export default class UnusedSucraseTransformer {\n  constructor() {\n    throw new Error('this sucrase transform is not bundled in Orca')\n  }\n}\n"

/** The stub's id when sucrase's transformer index imports an unused transformer; else null. */
export function resolveSucraseUnusedTransformer(
  source: string,
  importer: string | undefined
): string | null {
  return importer && SUCRASE_TRANSFORMERS_DIR.test(importer) && UNUSED_TRANSFORMERS.test(source)
    ? STUB_ID
    : null
}

/**
 * Replaces sucrase's flow and react-hot-loader transformers with a stub that throws. Why: their
 * emitted `require('flow-enums-runtime')` / `require('react-hot-loader')` strings read as runtime
 * imports to the packaged-dependency check, and the transpile worker only uses typescript and jsx.
 */
export function createSucraseUnusedTransformersPlugin(): Plugin {
  return {
    name: 'orca-sucrase-unused-transformers',
    enforce: 'pre',
    resolveId: resolveSucraseUnusedTransformer,
    load: (id) => (id === STUB_ID ? SUCRASE_UNUSED_TRANSFORMER_STUB : null)
  }
}
