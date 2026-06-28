import type { RuntimeClient } from '../runtime-client'

/** Options handed from the CommonJS command handler into the esbuild-bundled
 *  Ink app. Kept in a dependency-free module so both the tsc-built handler and
 *  the bundled `.tsx` entry can share the type without crossing the ESM/CJS
 *  boundary at type-check time. */
export type RunTuiOptions = {
  client: RuntimeClient
  isRemote: boolean
  /** Disable the alternate screen buffer (useful for debugging/recording). */
  noAltScreen: boolean
}

/** Shape the esbuild bundle (`tui-bundle.mjs`) exposes to the handler. */
export type TuiBundle = {
  runTui: (options: RunTuiOptions) => Promise<void>
}
