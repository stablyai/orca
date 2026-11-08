// NSIS sign hook is only on-disk moment for transient uninstaller: export unsigned bytes for SignPath, then import signed bytes before rebuild embeds it.
// Custom hook replaces signtool; adding CSC_LINK/WIN_CSC_LINK requires delegation or no signing occurs. Single env pair assumes one NSIS target/arch or concurrent uninstallers race.
const { createHash } = require('node:crypto')
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, dirname } = require('node:path')

// app-builder-lib names the intermediate uninstaller `<installer basename>__uninstaller.exe`.
const UNINSTALLER_BASENAME_SUFFIX = '__uninstaller.exe'

// Receipt binds exact bytes passed to makensis to SignPath digest; embedded NSIS section cannot be extracted with bundled 7za.
const EMBEDDED_RECEIPT_SUFFIX = '.embedded-sha256'

const isNsisUninstallerArtifact = (filePath) =>
  typeof filePath === 'string' && basename(filePath).endsWith(UNINSTALLER_BASENAME_SUFFIX)

// Relay failures stay nonfatal so existing installer can ship; return verdict for logs/tests.
function relayNsisUninstaller({
  filePath,
  exportPath,
  signedPath,
  fs = { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync }
}) {
  if (!isNsisUninstallerArtifact(filePath)) {
    return 'not-uninstaller'
  }
  try {
    // Import signed bytes before considering export, despite rebuild regenerating unsigned intermediate.
    if (signedPath) {
      if (!fs.existsSync(signedPath)) {
        return 'signed-missing'
      }
      fs.copyFileSync(signedPath, filePath)
      const digest = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
      fs.writeFileSync(`${signedPath}${EMBEDDED_RECEIPT_SUFFIX}`, digest)
      return 'imported'
    }
    if (exportPath) {
      fs.mkdirSync(dirname(exportPath), { recursive: true })
      fs.copyFileSync(filePath, exportPath)
      return 'exported'
    }
    return 'idle'
  } catch (error) {
    return `failed: ${error.message}`
  }
}

const VERDICT_MESSAGES = {
  imported: (paths) => `embedded the SignPath-signed uninstaller from ${paths.signedPath}`,
  exported: (paths) => `exported the unsigned uninstaller to ${paths.exportPath}`,
  'signed-missing': (paths) =>
    `no signed uninstaller at ${paths.signedPath}; embedding the unsigned one (fail-open)`
}

// Hook runs per executable/hash: cheap for other files and idempotent across SHA1/SHA256 uninstaller passes.
function signWindowsUninstallerViaSignPath(configuration) {
  const paths = {
    filePath: configuration?.path,
    exportPath: process.env.ORCA_WIN_UNINSTALLER_EXPORT_PATH || undefined,
    signedPath: process.env.ORCA_WIN_UNINSTALLER_SIGNED_PATH || undefined
  }
  const verdict = relayNsisUninstaller(paths)
  const message = VERDICT_MESSAGES[verdict]
  if (message) {
    console.log(`[win-uninstaller-signing] ${message(paths)}`)
  } else if (verdict.startsWith('failed')) {
    console.warn(`[win-uninstaller-signing] ${verdict}; embedding the unsigned uninstaller.`)
  }
}

module.exports = {
  EMBEDDED_RECEIPT_SUFFIX,
  UNINSTALLER_BASENAME_SUFFIX,
  isNsisUninstallerArtifact,
  relayNsisUninstaller,
  signWindowsUninstallerViaSignPath
}
