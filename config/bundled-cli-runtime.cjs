const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

function cliRuntimeTarget(platform, arch) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported CLI runtime target: ${platform}-${arch}`)
  }
  return `${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`
}

function cliRuntimeFilename(platform) {
  return platform === 'win32' ? 'bun-runtime.exe' : 'bun-runtime'
}

function cliRuntimeExtraResource(platform) {
  cliRuntimeTarget(platform, 'x64')
  return {
    from: `out/cli-runtime/${platform}-\${arch}`,
    to: 'cli-runtime',
    filter: [cliRuntimeFilename(platform), 'runtime.json', 'LICENSE.md']
  }
}

function verifyCliRuntimeDirectory(directory, platform, arch) {
  const { ORCAD_BUN_VERSION } = require('../src/shared/orcad-bun-runtime.ts')
  const expectedTarget = cliRuntimeTarget(platform, arch)
  const manifest = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'))
  if (
    manifest.target !== expectedTarget ||
    manifest.version !== ORCAD_BUN_VERSION ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error(`Invalid CLI runtime manifest for ${expectedTarget}`)
  }
  const license = readFileSync(join(directory, 'LICENSE.md'))
  const expectedLicense = readFileSync(
    join(__dirname, '..', 'resources', 'licenses', 'bun', 'LICENSE.md')
  )
  if (!license.equals(expectedLicense)) {
    throw new Error(`CLI runtime license notice mismatch for ${expectedTarget}`)
  }
  const binary = readFileSync(join(directory, cliRuntimeFilename(platform)))
  if (createHash('sha256').update(binary).digest('hex') !== manifest.sha256) {
    throw new Error(`CLI runtime checksum mismatch for ${expectedTarget}`)
  }
}

function assertBundledCliRuntimeBuilt(platform, archEnum, projectDir = join(__dirname, '..')) {
  const arch = { 1: 'x64', 3: 'arm64' }[archEnum]
  const target = cliRuntimeTarget(platform, arch)
  try {
    verifyCliRuntimeDirectory(
      join(projectDir, 'out', 'cli-runtime', `${platform}-${arch}`),
      platform,
      arch
    )
  } catch (error) {
    throw new Error(
      `Missing or damaged ${target} CLI runtime; run node config/scripts/build-cli-runtime.mjs --platform ${platform}.`,
      { cause: error }
    )
  }
}

module.exports = {
  cliRuntimeTarget,
  cliRuntimeFilename,
  cliRuntimeExtraResource,
  verifyCliRuntimeDirectory,
  assertBundledCliRuntimeBuilt
}
