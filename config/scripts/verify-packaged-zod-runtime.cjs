const { resolve } = require('node:path')
const { verifyPackagedZodRuntime } = require('../packaged-runtime-node-modules.cjs')

const packageDir = readPackageDir(process.argv.slice(2))
verifyPackagedZodRuntime(resolve(packageDir))
console.log(`[verify-packaged-zod-runtime] OK — ${resolve(packageDir)}`)

function readPackageDir(args) {
  const argument = args.find((value) => value.startsWith('--package-dir='))
  if (!argument) {
    throw new Error(
      'Usage: node config/scripts/verify-packaged-zod-runtime.cjs --package-dir=<path>'
    )
  }
  return argument.slice('--package-dir='.length)
}
