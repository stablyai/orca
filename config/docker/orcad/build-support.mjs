import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const out = resolve(root, 'out/orcad-docker')
const builtSourceFingerprint = process.env.ORCAD_BUILT_SOURCE_FINGERPRINT
if (!/^[a-f0-9]{64}$/.test(builtSourceFingerprint ?? '')) {
  throw new Error('Snapshot ORCAD_BUILT_SOURCE_FINGERPRINT before generating build inputs')
}
await build({
  entryPoints: ['entrypoint', 'healthcheck', 'install-providers'].map((name) =>
    resolve(import.meta.dirname, `${name}.mjs`)
  ),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outdir: out,
  outExtension: { '.js': '.cjs' },
  logLevel: 'warning'
})
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
await writeFile(
  resolve(out, 'build.json'),
  `${JSON.stringify(
    {
      version: pkg.version,
      revision: process.env.ORCAD_SOURCE_COMMIT,
      dirty: process.env.ORCAD_SOURCE_DIRTY === 'true',
      configuredSourceFingerprint: process.env.ORCAD_SOURCE_FINGERPRINT,
      builtSourceFingerprint,
      orcadVersion: (await readFile(resolve(root, 'out/orcad/.version'), 'utf8')).trim()
    },
    null,
    2
  )}\n`
)
