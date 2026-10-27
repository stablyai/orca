const { execFileSync } = require('node:child_process')
const { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const SHIPIT_SCHEDULING_ADDON = 'orca_shipit_scheduling.node'

function buildMacShipItScheduling(resourcesDir, arch) {
  if (process.platform !== 'darwin' || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Cannot build macOS installer scheduling for ${process.platform}/${arch}`)
  }
  const root = resolve(__dirname, '../..')
  const workDir = mkdtempSync(join(tmpdir(), `orca-shipit-scheduling-${arch}-`))
  try {
    cpSync(join(root, 'native/macos-shipit-scheduling'), workDir, { recursive: true })
    execFileSync(
      process.execPath,
      [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', `--arch=${arch}`],
      { cwd: workDir, stdio: 'inherit' }
    )
    const built = join(workDir, 'build/Release', SHIPIT_SCHEDULING_ADDON)
    const expectedArch = arch === 'x64' ? 'x86_64' : 'arm64'
    execFileSync('/usr/bin/lipo', [built, '-verify_arch', expectedArch])
    mkdirSync(resourcesDir, { recursive: true })
    const target = join(resourcesDir, SHIPIT_SCHEDULING_ADDON)
    copyFileSync(built, target)
    return target
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

module.exports = { buildMacShipItScheduling, SHIPIT_SCHEDULING_ADDON }
