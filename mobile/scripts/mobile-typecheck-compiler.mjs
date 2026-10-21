import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProjectCompilerInfo } from '../../config/scripts/run-typecheck-projects-in-parallel.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)

export function resolveMobileTypecheckCompiler() {
  const mode = process.env.ORCA_MOBILE_TYPECHECK_COMPILER ?? 'javascript'
  if (mode !== 'javascript' && mode !== 'native') {
    throw new Error(`Unknown mobile typecheck compiler: ${mode}`)
  }
  const native = mode === 'native'
  // Expo needs mobile's JavaScript compiler API; CI can use the root native compiler.
  const compiler = resolveProjectCompilerInfo(
    native ? 'package.json' : 'mobile/tsconfig.json',
    root
  )
  if (native) {
    // Use the package's resolver, then let process-host hide Windows children.
    const getExecutablePath = require(
      join(dirname(compiler.program), '../lib/getExePath.js')
    ).default
    return {
      program: getExecutablePath(),
      args: ['--incremental', 'false'],
      native,
      version: compiler.version
    }
  }
  return {
    program: process.execPath,
    args: [compiler.program],
    native,
    version: compiler.version
  }
}
