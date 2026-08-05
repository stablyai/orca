import { BOOTSTRAP_FATAL_EXIT_GUARD_KEY } from '../../src/main/startup/bootstrap-fatal-exit-guard'
export const BOOTSTRAP_FATAL_LOG_ENV_VAR = 'ORCA_BOOTSTRAP_FATAL_LOG'
export const BOOTSTRAP_FATAL_LOG_FILE_NAME = 'bootstrap-fatal.log'
const BOOTSTRAP_FATAL_LOG_MAX_BYTES = 262_144

export function createBootstrapFatalExitBanner(): string {
  // Why: Electron's pre-import error dialog can leave main resident and block NSIS replacement.
  // Suppressing that dialog also removes the only account of the failure, so record one first:
  // a partially copied resources tree otherwise exits silently on every launch, with nothing
  // for the user or a support log to name the module that was missing.
  return `
;(() => {
  const guardKey = ${JSON.stringify(BOOTSTRAP_FATAL_EXIT_GUARD_KEY)}
  if (typeof globalThis[guardKey] === 'function') {
    return
  }
  const describeBootstrapError = (error) => {
    try {
      const detail = error && typeof error === 'object' && error.stack ? error.stack : error
      return String(detail).split('\\n').slice(0, 12).join(' | ').slice(0, 4000)
    } catch {
      return '<unprintable error>'
    }
  }
  const readBootstrapFatalLogOverride = () => {
    const override = typeof process.env === 'object' && process.env ? process.env.${BOOTSTRAP_FATAL_LOG_ENV_VAR} : undefined
    return typeof override === 'string' && override.length > 0 ? override : undefined
  }
  const resolveDefaultBootstrapFatalLogPath = () => {
    let directory
    try {
      directory = require('electron').app.getPath('userData')
    } catch {
      // Why: a bootstrap fault can predate a usable app object; temp still outlives the process.
      directory = require('node:os').tmpdir()
    }
    return require('node:path').join(directory, ${JSON.stringify(BOOTSTRAP_FATAL_LOG_FILE_NAME)})
  }
  const appendBootstrapFatalLine = (fs, logPath, entry) => {
    try {
      // Why: an override can name a directory nothing has created yet, and a missing
      // parent would drop the only account of the failure.
      fs.mkdirSync(require('node:path').dirname(logPath), { recursive: true })
      // Why: a broken install repeats this on every relaunch; keep the trail bounded.
      let flags = 'a'
      try {
        flags = fs.statSync(logPath).size > ${BOOTSTRAP_FATAL_LOG_MAX_BYTES} ? 'w' : 'a'
      } catch {
        flags = 'a'
      }
      const descriptor = fs.openSync(logPath, flags, 0o600)
      try {
        fs.writeSync(descriptor, entry)
      } finally {
        fs.closeSync(descriptor)
      }
      return true
    } catch {
      return false
    }
  }
  const recordBootstrapFailure = (error) => {
    const line = '[bootstrap] fatal-exit pid=' + process.pid + ' error=' + describeBootstrapError(error) + '\\n'
    let fs
    try {
      fs = require('node:fs')
    } catch {
      fs = undefined
    }
    try {
      fs.writeSync(2, line)
    } catch {
      try {
        process.stderr.write(line)
      } catch {
        // Diagnostics must never replace the exit below.
      }
    }
    try {
      const entry = new Date().toISOString() + ' ' + line
      const override = readBootstrapFatalLogOverride()
      // Why: an unwritable override must cost the user a location, not the diagnostic.
      if (!override || !appendBootstrapFatalLine(fs, override, entry)) {
        appendBootstrapFatalLine(fs, resolveDefaultBootstrapFatalLogPath(), entry)
      }
    } catch {
      // Diagnostics must never replace the exit below.
    }
  }
  let exitScheduled = false
  const exitAfterBootstrapFailure = (error) => {
    if (exitScheduled) {
      return
    }
    exitScheduled = true
    recordBootstrapFailure(error)
    process.exitCode = 1
    setImmediate(() => process.exit(1))
  }
  globalThis[guardKey] = () => {
    process.off('uncaughtException', exitAfterBootstrapFailure)
    delete globalThis[guardKey]
  }
  process.once('uncaughtException', exitAfterBootstrapFailure)
})();
`
}
