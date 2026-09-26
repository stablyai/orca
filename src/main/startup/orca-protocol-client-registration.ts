import path from 'node:path'
import { app } from 'electron'

export function registerOrcaProtocolClient(): void {
  if (process.platform === 'linux') {
    // Why: Electron derives the runtime desktop entry name from `app.name` ('orca'), which the
    // Linux installer never ships (electron-builder.config.cjs names it `orca-ide.desktop` to
    // avoid colliding with the GNOME Orca screen reader package). Without this, dev-mode
    // protocol registration silently resolves to a nonexistent desktop file and does nothing.
    app.setDesktopName('orca-ide.desktop')
  }
  if (app.isDefaultProtocolClient('orca')) {
    return
  }
  if (process.defaultApp && process.argv.length >= 2) {
    // Dev mode: Windows needs an explicit executable path and args, or it registers
    // `electron.exe "%1"` and clicking a link launches bare Electron with no entry point.
    app.setAsDefaultProtocolClient('orca', process.execPath, [path.resolve(process.argv[1])])
  } else {
    // Why gated: an unconditional re-assert on every dev launch could hijack the scheme away
    // from a correctly registered packaged install.
    app.setAsDefaultProtocolClient('orca')
  }
}
