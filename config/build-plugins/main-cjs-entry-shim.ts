import type { Plugin } from 'vite'
import { createInheritedOrcaIdentityDropBanner } from './inherited-orca-identity-banner'

const MAIN_RUNTIME_FILE_NAME = 'main-runtime.js'
const MAIN_RUNTIME_MAP_FILE_NAME = `${MAIN_RUNTIME_FILE_NAME}.map`

/**
 * Moves the large CommonJS `index.js` bundle to `main-runtime.js` in the same `out/main/`
 * directory (preserving `__dirname` and hidden sourcemap line offsets) and leaves a tiny
 * `index.js` CJS shim. Electron loads `package.json#main` through Node's ESM `ModuleLoader`,
 * which pins the entry file's full source string in `Module.<symbol node:module_source>` forever;
 * loading the runtime bundle via `require('./main-runtime.js')` avoids retaining a second ~7.5 MiB
 * copy of the main bundle source in V8 heap.
 */
export function createMainCjsEntryShimPlugin(): Plugin {
  return {
    name: 'orca-main-cjs-entry-shim',
    generateBundle(_options, bundle) {
      const entry = bundle['index.js']
      if (!entry || entry.type !== 'chunk') {
        return
      }
      this.emitFile({
        type: 'asset',
        fileName: MAIN_RUNTIME_FILE_NAME,
        source: entry.code
      })
      const entryMap = bundle['index.js.map']
      if (entryMap && entryMap.type === 'asset') {
        this.emitFile({
          type: 'asset',
          fileName: MAIN_RUNTIME_MAP_FILE_NAME,
          source: entryMap.source
        })
        delete bundle['index.js.map']
      }
      entry.code = `${createInheritedOrcaIdentityDropBanner()}module.exports = require('./${MAIN_RUNTIME_FILE_NAME}')\n`
    }
  }
}
