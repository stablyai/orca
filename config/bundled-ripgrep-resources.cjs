const { chmodSync, existsSync } = require('node:fs')
const { join } = require('node:path')

// Ship every relay platform: SSH uploads remote-host rg from local bundle; WSL uses Linux rg from Windows installs.
const BUNDLED_RIPGREP_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
]
const RIPGREP_PACKAGE_BIN_DIR = 'node_modules/@vscode/ripgrep-universal/bin'
const RIPGREP_RESOURCE_DIR = 'ripgrep'

function ripgrepBinaryName(platform) {
  return platform.startsWith('win32-') ? 'rg.exe' : 'rg'
}

const bundledRipgrepExtraResources = [
  {
    from: RIPGREP_PACKAGE_BIN_DIR,
    to: RIPGREP_RESOURCE_DIR,
    filter: BUNDLED_RIPGREP_PLATFORMS.map((platform) => `${platform}/**`)
  },
  // Static PCRE2/musl/jemalloc/LLVM libunwind require redistribution notices; copy the whole directory to include future notices.
  { from: 'resources/licenses/ripgrep', to: `${RIPGREP_RESOURCE_DIR}/licenses` }
]

// Why: codesign would try to sign the Linux/Windows builds; they are inert data on macOS.
const bundledRipgrepMacSignIgnore = ['/ripgrep/(linux|win32)-']

// Why: electron-builder only warns on a missing extraResources source.
function assertBundledRipgrepInstalled(projectDir = join(__dirname, '..')) {
  const missing = BUNDLED_RIPGREP_PLATFORMS.filter(
    (platform) =>
      !existsSync(join(projectDir, RIPGREP_PACKAGE_BIN_DIR, platform, ripgrepBinaryName(platform)))
  )
  if (missing.length > 0) {
    throw new Error(
      `@vscode/ripgrep-universal is missing binaries for ${missing.join(', ')}; run pnpm install.`
    )
  }
}

function finalizePackagedRipgrep(resourcesDir) {
  for (const platform of BUNDLED_RIPGREP_PLATFORMS) {
    const binaryPath = join(
      resourcesDir,
      RIPGREP_RESOURCE_DIR,
      platform,
      ripgrepBinaryName(platform)
    )
    if (!existsSync(binaryPath)) {
      throw new Error(`Packaged app is missing bundled ripgrep: ${binaryPath}`)
    }
    // Why: the upstream tarball's exec bits are not guaranteed after copying.
    chmodSync(binaryPath, 0o755)
  }
}

module.exports = {
  BUNDLED_RIPGREP_PLATFORMS,
  RIPGREP_PACKAGE_BIN_DIR,
  RIPGREP_RESOURCE_DIR,
  ripgrepBinaryName,
  assertBundledRipgrepInstalled,
  bundledRipgrepExtraResources,
  bundledRipgrepMacSignIgnore,
  finalizePackagedRipgrep
}
