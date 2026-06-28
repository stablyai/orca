#!/usr/bin/env node
// Bundles the TUI into a single ESM module the tsc-built (CJS) CLI loads via a
// native dynamic import(). The TUI owns the terminal directly (a manual ANSI
// compositor, no Ink); bundling avoids migrating the whole CLI bin off CommonJS.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function main() {
  await build({
    entryPoints: [path.join(projectDir, 'src/cli/tui/tui-entry.ts')],
    outfile: path.join(projectDir, 'out/cli/tui/tui-bundle.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    // Why: the bundle is loaded through a native dynamic import() from the
    // CommonJS handler, so it must stay ESM.
    format: 'esm',
    // Why: some bundled CJS deps (e.g. signal-exit) call require() for Node
    // built-ins; ESM output has no require, so provide one via createRequire.
    banner: {
      js: "import { createRequire as __cliTuiCreateRequire } from 'module'; const require = __cliTuiCreateRequire(import.meta.url);"
    },
    logLevel: 'info'
  })

  // Guard the exact failure mode the handler hits: tsc compiles the CLI to
  // CommonJS, and the bundle must load from a CommonJS context via a native
  // dynamic import. Verify that here so a regression fails the build, not the
  // user at runtime.
  verifyBundleLoadsFromCommonjs(path.join(projectDir, 'out/cli/tui/tui-bundle.mjs'))
}

function verifyBundleLoadsFromCommonjs(bundlePath) {
  const url = pathToFileURL(bundlePath).href
  const probe = `const importEsm = new Function('s', 'return import(s)');
importEsm(${JSON.stringify(url)})
  .then((m) => { if (typeof m.runTui !== 'function') { throw new Error('runTui export missing'); } })
  .catch((err) => { console.error(err); process.exit(1); });`
  execFileSync(process.execPath, ['-e', probe], { stdio: 'inherit' })
  console.log('[cli-tui] verified bundle loads from CommonJS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
