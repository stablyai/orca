import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { mkdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '../..')
const destination = resolve(process.argv[2] ?? resolve(root, 'out/standalone/chrome-devtools.cjs'))
const temporary = `${destination}.${randomUUID()}.tmp`
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
await mkdir(dirname(destination), { recursive: true })
try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/cli/chrome-devtools-standalone.ts'],
    outfile: temporary,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    metafile: true,
    legalComments: 'inline',
    logLevel: 'warning'
  })
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !builtins.has(dependency.path)) {
        throw new Error(`Standalone bridge has an external package dependency: ${dependency.path}`)
      }
    }
  }
  await rename(temporary, destination)
  console.log(destination)
} finally {
  await rm(temporary, { force: true })
}
