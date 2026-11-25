import { basename } from 'node:path'
import { isScriptOutput } from './mobile-web-app-chunk-grouping.mjs'

// One lazily imported chunk per UI language; the page fetches only the active one after init.
const LOCALE_CATALOG_INPUT = /(^|\/)src\/i18n\/locales\/[^/]+\.json$/
// The diagram engine: shells that serve it on request fetch it from the desktop when the page first draws a diagram.
const DEFERRED_INPUT = /(^|\/)src\/components\/mermaid\/mermaid-page-engine\.generated\.ts$/

function outputsBuiltOnlyFrom(metafile, pattern) {
  return new Set(
    Object.entries(metafile.outputs)
      .filter(([, output]) => {
        const inputs = Object.keys(output.inputs ?? {})
        return inputs.length > 0 && inputs.every((input) => pattern.test(input))
      })
      .map(([output]) => basename(output))
  )
}

export const localeCatalogOutputs = (metafile) =>
  outputsBuiltOnlyFrom(metafile, LOCALE_CATALOG_INPUT)

// A static import of a deferred chunk would fail to load on shells that fetch it only on request.
export function deferredOutputs(metafile) {
  const deferred = outputsBuiltOnlyFrom(metafile, DEFERRED_INPUT)
  for (const [path, output] of Object.entries(metafile.outputs)) {
    const imported = output.imports.find(
      (entry) => entry.kind === 'import-statement' && deferred.has(basename(entry.path))
    )
    if (imported) {
      throw new Error(
        `[build-mobile-web-app-bundle] ${path} statically imports the deferred diagram engine; import it lazily`
      )
    }
  }
  return deferred
}

// The entry and its chunks, without locale catalogs: what the chunk fence and its sweep table count.
export function pageScriptCount(metafile) {
  const catalogs = localeCatalogOutputs(metafile)
  return Object.keys(metafile.outputs).filter(
    (output) => isScriptOutput(output) && !catalogs.has(basename(output))
  ).length
}
