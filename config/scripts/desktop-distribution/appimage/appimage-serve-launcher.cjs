const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { generateAppRunScript } = require('app-builder-lib/out/targets/appimage/appImageUtil')

// The shared Linux app tree also feeds deb/rpm, where AppRun would imply an extracted AppImage.
const appImageServeLauncherFpmArgs = ['--exclude', '*/AppRun']

function writeAppImageServeLauncher(context) {
  const { appInfo, executableName } = context.packager
  if (context.packager.config.appImage?.license) {
    throw new Error('The AppImage serve launcher needs license handling before enabling an EULA')
  }
  const desktop = generateAppRunScript({
    ExecutableName: executableName,
    ProductName: appInfo.productName,
    ProductFilename: appInfo.productFilename,
    DesktopFileName: `${executableName}.desktop`,
    ResourceName: `appimagekit-${executableName}`
  })
  const marker = `BIN="$APPDIR/${executableName}"\n`
  if (desktop.split(marker).length !== 2) {
    throw new Error('The electron-builder AppRun template changed; cannot install serve routing')
  }
  const routing = `
# Chromium zygotes cannot be reaped after main execs into the CLI; enter Node before Chromium starts.
if [ "\${1-}" = serve ] ; then
  exec "$APPDIR/resources/bin/orca-ide" "$@"
fi
`
  // The static AppImage builder copies appOutDir over its generated stage launcher.
  writeFileSync(join(context.appOutDir, 'AppRun'), desktop.replace(marker, marker + routing), {
    mode: 0o755
  })
}

module.exports = { appImageServeLauncherFpmArgs, writeAppImageServeLauncher }
