// Loads src TypeScript modules from a plain Node script, so the generator and the validator run the
// exact runtime schemas without a TypeScript loader.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import * as esbuild from 'esbuild'

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

function loadBundle(entry) {
  // Why under out/: the bundle keeps zod external, so it must resolve from the repo's node_modules.
  mkdirSync(path.join(REPO_ROOT, 'out'), { recursive: true })
  const buildDir = mkdtempSync(path.join(REPO_ROOT, 'out', 'plugin-schemas-'))
  try {
    const outfile = path.join(buildDir, 'bundle.cjs')
    esbuild.buildSync({
      ...entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      logLevel: 'error',
      packages: 'external'
    })
    return createRequire(import.meta.url)(outfile)
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
}

export function loadPluginSchemaModule(fileName) {
  return loadBundle({ entryPoints: [path.join(REPO_ROOT, 'src', 'shared', 'plugins', fileName)] })
}

/** One bundle for several repo-relative modules, exposed as `{ [name]: moduleExports }`. */
export function loadRepoTypeScriptModules(modules) {
  const contents = Object.entries(modules)
    .map(([name, file]) => `export * as ${name} from ${JSON.stringify(`./${file}`)}`)
    .join('\n')
  return loadBundle({
    stdin: { contents, resolveDir: REPO_ROOT, loader: 'ts', sourcefile: 'modules.ts' }
  })
}
