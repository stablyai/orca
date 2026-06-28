import { existsSync } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import type { RunTuiOptions, TuiBundle } from '../tui/tui-runtime-contract'

/** Injected dependencies — defaulted in production, overridden in tests so the
 *  TTY/runtime guards can be exercised without loading the Ink bundle. */
export type TuiCommandDeps = {
  isTty: () => boolean
  loadBundle: () => Promise<TuiBundle>
  writeStderr: (text: string) => void
}

// Why: tsc compiles this file to CommonJS, which rewrites a bare `import()` into
// require() — and require() cannot load an ESM .mjs. Building the import through
// the Function constructor hides it from tsc so the native dynamic import (which
// can load ESM from CJS) survives transpilation.
// eslint-disable-next-line no-new-func -- intentional native dynamic import shim
const importEsmModule = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<unknown>

// The Ink/React app is ESM-only (top-level await in Ink/yoga) and ships as an
// esbuild ESM bundle beside the tsc-built handler; we dynamic-import it by file
// URL so the CommonJS CLI never statically imports an ESM-only module.
async function loadTuiBundle(): Promise<TuiBundle> {
  const bundlePath = path.join(__dirname, '..', 'tui', 'tui-bundle.mjs')
  // The bundle is produced by the esbuild step in `build:cli`; a tsc-only build
  // omits it. Fail with a clear instruction instead of a raw module error.
  if (!existsSync(bundlePath)) {
    throw new RuntimeClientError(
      'tui_bundle_missing',
      'The orca tui bundle is missing. Run `pnpm build:cli` (or `pnpm build`) to build it, then retry.'
    )
  }
  return (await importEsmModule(pathToFileURL(bundlePath).href)) as TuiBundle
}

const DEFAULT_DEPS: TuiCommandDeps = {
  isTty: () => Boolean(process.stdout.isTTY && process.stdin.isTTY),
  loadBundle: loadTuiBundle,
  writeStderr: (text) => process.stderr.write(text)
}

export async function runTuiCommand(
  ctx: HandlerContext,
  deps: TuiCommandDeps = DEFAULT_DEPS
): Promise<void> {
  if (!deps.isTty()) {
    // Why: a full-screen TUI is meaningless without an interactive terminal;
    // fail loudly so piped/CI invocations get a clear signal instead of a hang.
    deps.writeStderr(
      'orca tui requires an interactive terminal (TTY). Run it directly in your terminal.\n'
    )
    process.exitCode = 1
    return
  }

  const status = await ctx.client.getCliStatus()
  if (!status.result.runtime.reachable) {
    if (ctx.client.isRemote) {
      // A remote runtime can't be launched from here — it must be paired/started.
      throw new RuntimeClientError(
        'runtime_unreachable',
        'Remote Orca runtime is not reachable. Pair or start it, then retry.'
      )
    }
    // No local runtime yet: launch Orca and wait for it (openOrca connects when
    // it comes up and throws on timeout; it no-ops when already reachable).
    deps.writeStderr('Orca is not running — starting it…\n')
    await ctx.client.openOrca()
  }

  const options: RunTuiOptions = {
    client: ctx.client,
    isRemote: ctx.client.isRemote,
    noAltScreen: ctx.flags.get('no-alt-screen') === true
  }
  const bundle = await deps.loadBundle()
  await bundle.runTui(options)
}

export const TUI_HANDLERS: Record<string, CommandHandler> = {
  tui: (ctx) => runTuiCommand(ctx)
}
