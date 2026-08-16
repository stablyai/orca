import type { Plugin, Rollup } from 'vite'

const BROWSER_GUEST_PRELOAD_ENTRY = 'browser-guest-preload'

export function createBrowserGuestPreloadEntryGuardPlugin(): Plugin {
  return {
    name: 'orca-browser-guest-preload-entry-guard',
    buildStart(options: Rollup.NormalizedInputOptions) {
      if (
        typeof options.input === 'string' ||
        Array.isArray(options.input) ||
        !(BROWSER_GUEST_PRELOAD_ENTRY in options.input)
      ) {
        throw new Error(
          `[browser-guest-preload-entry-guard] "${BROWSER_GUEST_PRELOAD_ENTRY}" is not a Rollup input`
        )
      }
    },
    generateBundle(_options, bundle: Rollup.OutputBundle) {
      const entry = Object.values(bundle).find(
        (output): output is Rollup.OutputChunk =>
          output.type === 'chunk' && output.isEntry && output.name === BROWSER_GUEST_PRELOAD_ENTRY
      )
      if (!entry) {
        throw new Error(
          `[browser-guest-preload-entry-guard] missing built entry "${BROWSER_GUEST_PRELOAD_ENTRY}"`
        )
      }
      const dependencies = [...entry.imports, ...entry.dynamicImports]
      if (dependencies.length > 0) {
        throw new Error(
          `[browser-guest-preload-entry-guard] "${entry.fileName}" must be standalone but imports ${dependencies.join(', ')}`
        )
      }
    }
  }
}
