const { spawnSync } = require('node:child_process')
const { chmodSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { collectNativeBinaries } = require('./scripts/verify-linux-glibc-floor.cjs')

function ensureBundledWaylandClipboard(archEnum, root = join(__dirname, '..'), run = spawnSync) {
  const arch = { 1: 'x64', 3: 'arm64' }[archEnum]
  if (!arch) {
    throw new Error(`Unsupported Wayland clipboard packaging architecture: ${archEnum}`)
  }
  const result = run(
    process.execPath,
    [join(root, 'config', 'scripts', 'build-wayland-clipboard.mjs'), '--arch', arch],
    { cwd: root, stdio: 'inherit' }
  )
  if (
    result.error ||
    result.status !== 0 ||
    !existsSync(join(root, 'native', 'wayland-clipboard', '.build', arch, 'orca-wayland-clipboard'))
  ) {
    throw new Error('The Linux package requires a built Wayland clipboard helper.')
  }
}

function finalizePackagedWaylandClipboard(resourcesDir) {
  const binDir = join(resourcesDir, 'bin')
  const helper = join(binDir, 'orca-wayland-clipboard')
  if (!existsSync(helper) || !collectNativeBinaries(binDir).includes(helper)) {
    throw new Error('The Linux package is missing its Wayland clipboard executable.')
  }
  chmodSync(helper, 0o755)
}

module.exports = { ensureBundledWaylandClipboard, finalizePackagedWaylandClipboard }
