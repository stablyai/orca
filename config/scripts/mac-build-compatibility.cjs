const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const compatibilityContract = require('../../src/shared/local-build-compatibility-contract.json')

const MAC_BUILD_COMPATIBILITY_FILENAME = 'orca-local-build.json'

function createMacBuildCompatibility({ version, commit, architecture }) {
  if (architecture !== 'arm64' && architecture !== 'x64') {
    throw new Error(`Unsupported macOS build architecture: ${architecture}`)
  }
  return {
    ...compatibilityContract,
    buildId: `${version}-${commit}-${architecture}`,
    version,
    commit,
    platform: 'darwin',
    architecture
  }
}

function writeMacBuildCompatibility(resourcesDir, identity) {
  const compatibility = createMacBuildCompatibility(identity)
  writeFileSync(
    join(resourcesDir, MAC_BUILD_COMPATIBILITY_FILENAME),
    `${JSON.stringify(compatibility, null, 2)}\n`,
    'utf8'
  )
}

module.exports = {
  MAC_BUILD_COMPATIBILITY_FILENAME,
  createMacBuildCompatibility,
  writeMacBuildCompatibility
}
