import { build } from 'esbuild'
import { join } from 'node:path'
import { ORCAD_LINEAR_SDK_ENTRY } from '../../src/shared/orcad-artifacts.ts'

/**
 * @linear/sdk as one CommonJS file where orcad's lazy `require('@linear/sdk')` resolves it.
 * Why bundled rather than copied: the package ships hashed chunk names that change every release.
 */
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
