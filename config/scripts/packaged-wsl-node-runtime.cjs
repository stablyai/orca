// Windows installers bundle the pinned Linux Node archive for their own architecture, so a first WSL
// deploy needs no network (the orcad template ships no runtime, D2). beforePack stages it, hash-verified;
// afterPack proves the packaged copy. A shipped template without its archive is a packaging failure.
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const {
  BUNDLED_NODE_RUNTIME_ARCHIVE_DIRNAME,
  nodeRuntimeReleaseUrl,
  pinnedNodeRuntimeAsset,
  windowsInstallerBundledNodeTarget
} = require('../../src/shared/node-runtime-pin.ts')

const WSL_NODE_RUNTIME_BUILD_DIR = 'out/wsl-node-runtime'
const wslNodeRuntimeExtraResource = {
  from: `${WSL_NODE_RUNTIME_BUILD_DIR}/\${arch}`,
  to: BUNDLED_NODE_RUNTIME_ARCHIVE_DIRNAME
}

// electron-builder's Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
function windowsInstallerArch(archEnum) {
  const arch = { 1: 'x64', 3: 'arm64' }[archEnum]
  if (!arch) {
    throw new Error(`[packaged-wsl-node-runtime] no WSL Node archive for Windows arch ${archEnum}`)
  }
  return arch
}

function bundledArchive(archEnum) {
  const arch = windowsInstallerArch(archEnum)
  const asset = pinnedNodeRuntimeAsset(windowsInstallerBundledNodeTarget(arch))
  return { arch, asset }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Fetch (or reuse) the hash-verified archive; any failure fails packaging instead of shipping without it. */
async function stageWslNodeRuntimeArchive(archEnum, options = {}) {
  const projectDir = options.projectDir ?? join(__dirname, '..', '..')
  const { arch, asset } = bundledArchive(archEnum)
  const destination = join(projectDir, WSL_NODE_RUNTIME_BUILD_DIR, arch, asset.archive)
  const fetchFile =
    options.fetchFile ?? (await import('./pinned-node-downloads.mjs')).fetchPinnedFile
  await fetchFile({
    url: nodeRuntimeReleaseUrl(asset.source, asset.archive),
    destination,
    sha256: asset.archiveSha256
  })
  if (!existsSync(destination) || sha256(destination) !== asset.archiveSha256) {
    throw new Error(
      `[packaged-wsl-node-runtime] ${destination} is missing or does not match the Node runtime pin`
    )
  }
  return destination
}

function verifyPackagedWslNodeRuntime(resourcesDir, archEnum) {
  const { asset } = bundledArchive(archEnum)
  const packaged = join(resourcesDir, BUNDLED_NODE_RUNTIME_ARCHIVE_DIRNAME, asset.archive)
  if (!existsSync(packaged) || sha256(packaged) !== asset.archiveSha256) {
    throw new Error(
      `[packaged-wsl-node-runtime] the installer is missing the pinned WSL Node archive: ${packaged}`
    )
  }
}

module.exports = {
  WSL_NODE_RUNTIME_BUILD_DIR,
  stageWslNodeRuntimeArchive,
  verifyPackagedWslNodeRuntime,
  windowsInstallerArch,
  wslNodeRuntimeExtraResource
}
