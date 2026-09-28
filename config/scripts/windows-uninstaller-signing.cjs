// Why this exists: the NSIS uninstaller is the one Orca binary SignPath never
// saw. app-builder-lib builds it in a separate makensis pass, hands it to the
// packager's sign hook, embeds it in the installer, then deletes it
// (NsisTarget.computeScriptAndSignUninstaller → packager.signIf(uninstallerPath),
// then `unlink(defines.UNINSTALLER_OUT_FILE)`). That hook is the only moment the
// file exists on disk, so it is the only place a post-hoc signer can reach it.
//
// Orca does not sign during electron-builder — SignPath signs afterwards, behind
// a human approval — so instead of signing, this hook relays: build 1 exports the
// unsigned uninstaller so CI can put it in the existing inner-binaries SignPath
// request, and the rebuild-from-signed-tree pass swaps the signed bytes back in
// before makensis embeds them.
//
// Trap for whoever adds a real certificate to the Windows build: a custom sign
// hook *replaces* signtool rather than running alongside it — windowsSignToolManager
// does `const executor = customSign || (config => this.doSign(config))`. Inert
// today (no CSC_LINK/WIN_CSC_LINK anywhere in the Windows workflows), but setting
// one would silently sign nothing until this hook learns to delegate.
//
// Trap for whoever adds a second NSIS target or arch: app-builder-lib names the
// intermediate uninstaller per target *and* arch, while the relay is a single
// pair of env vars. Two targets would race — last write wins on export, every
// installer would embed the same uninstaller, and the receipt could not tell.
// Release is x64-only `--win` with `win.target` unset (so `["nsis"]`) today.
const { createHash } = require('node:crypto')
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, dirname } = require('node:path')

// app-builder-lib names the intermediate uninstaller `<installer basename>__uninstaller.exe`.
const UNINSTALLER_BASENAME_SUFFIX = '__uninstaller.exe'

// Why a receipt: NSIS embeds the uninstaller in its own compressed data section,
// not in the app 7z payload the evidence gate extracts, so the shipped installer
// cannot be inspected for it with the bundled 7za. The receipt records the digest
// of the exact bytes handed to makensis, which the gate compares against the
// SignPath-returned file — proving what was embedded without extracting it.
const EMBEDDED_RECEIPT_SUFFIX = '.embedded-sha256'

const isNsisUninstallerArtifact = (filePath) =>
  typeof filePath === 'string' && basename(filePath).endsWith(UNINSTALLER_BASENAME_SUFFIX)

/**
 * Pure relay. Returns a short verdict string for logging and tests.
 * Never throws: a relay failure must ship today's installer, not break the build.
 */
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
    // Import wins over export: the rebuild pass must embed the signed bytes even
    // though it also regenerates an unsigned uninstaller of its own.
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

/**
 * electron-builder `win.signtoolOptions.sign` hook. Called for every Windows
 * executable, twice per file (once per signing hash), so it must be cheap for
 * non-uninstaller paths and idempotent for the uninstaller.
 */
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
