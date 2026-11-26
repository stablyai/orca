const { execFileSync } = require('node:child_process')
const { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

function buildMacNativeAddon(resourcesDir, arch, nativeDir, addonName) {
  if (process.platform !== 'darwin' || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Cannot build macOS native addon for ${process.platform}/${arch}`)
  }
  const root = resolve(__dirname, '../../../..')
  const workDir = mkdtempSync(join(tmpdir(), `orca-${nativeDir}-${arch}-`))
  try {
    cpSync(join(root, 'native', nativeDir), workDir, { recursive: true })
    execFileSync(
      process.execPath,
      [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', `--arch=${arch}`],
      { cwd: workDir, stdio: 'inherit' }
    )
    const built = join(workDir, 'build/Release', addonName)
    const expectedArch = arch === 'x64' ? 'x86_64' : 'arm64'
    execFileSync('/usr/bin/lipo', [built, '-verify_arch', expectedArch])
    mkdirSync(resourcesDir, { recursive: true })
    const target = join(resourcesDir, addonName)
    copyFileSync(built, target)
    return target
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

module.exports = { buildMacNativeAddon }
