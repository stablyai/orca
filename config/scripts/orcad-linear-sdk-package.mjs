import { build } from 'esbuild'
import { join } from 'node:path'
import { ORCAD_LINEAR_SDK_ENTRY } from '../../src/shared/orcad-artifacts.ts'

// Bundle @linear/sdk into one CJS file for lazy require: copying would expose chunk names that change each release.
export async function stageOrcadLinearSdk(root, outputDir) {
  await build({
    stdin: {
      contents: "module.exports = require('@linear/sdk')",
      resolveDir: root,
      sourcefile: 'orcad-linear-sdk-entry.js'
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(outputDir, ORCAD_LINEAR_SDK_ENTRY),
    minify: true,
    sourcemap: false,
    logLevel: 'error'
  })
}
