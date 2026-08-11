import type { Plugin } from 'vite'
import { createBootstrapFatalExitBanner } from './bootstrap-fatal-exit-banner'

export const MAIN_PROCESS_BOOTSTRAP_FILE = 'bootstrap.cjs'
export const MAIN_PROCESS_BUNDLE_FILE = 'index.js'
export const MAIN_PROCESS_COMPILE_CACHE_DIRECTORY = 'v8-compile-cache'
export const MAIN_PROCESS_DEVELOPMENT_CACHE_PARENT_DIRECTORY = '.cache'

export function createStartupDiagnosticsBanner(chunkName: string): string {
  return `
;(() => {
  const env = typeof process !== 'undefined' ? process.env : undefined
  const mode = env?.ORCA_STARTUP_DIAGNOSTICS
  if (mode !== '1' && mode !== 'trace') {
    return
  }
  const safeJson = (value) => {
    try {
      return JSON.stringify(value)
    } catch {
      return '"<unserializable>"'
    }
  }
  let closeSync
  let diagnosticFileDescriptor
  let openSync
  let writeSync
  try {
    const fs = require('node:fs')
    closeSync = fs.closeSync
    openSync = fs.openSync
    writeSync = fs.writeSync
  } catch {
    closeSync = undefined
    openSync = undefined
    writeSync = undefined
  }
  const diagnosticFile = env?.ORCA_STARTUP_DIAGNOSTICS_FILE
  if (typeof diagnosticFile === 'string' && diagnosticFile.length > 0 && typeof openSync === 'function') {
    try {
      diagnosticFileDescriptor = openSync(diagnosticFile, 'a', 0o600)
    } catch {
      diagnosticFileDescriptor = undefined
    }
  }
  const writeLine = (message) => {
    try {
      const line = message.endsWith('\\n') ? message : message + '\\n'
      if (typeof writeSync === 'function') {
        writeSync(2, line)
        if (typeof diagnosticFileDescriptor === 'number') {
          writeSync(diagnosticFileDescriptor, line)
        }
      }
    } catch {
      // Diagnostics must never affect startup.
    }
  }
  const chunkName = ${JSON.stringify(chunkName)}
  writeLine('[bootstrap] bundle-enter chunk=' + safeJson(chunkName) + ' pid=' + process.pid + ' ppid=' + process.ppid + ' execPath=' + safeJson(process.execPath) + ' argv=' + safeJson(process.argv) + ' electronRunAsNode=' + safeJson(env?.ELECTRON_RUN_AS_NODE ?? null))
  if (!globalThis.__ORCA_BOOTSTRAP_EXIT_LOG_INSTALLED__) {
    globalThis.__ORCA_BOOTSTRAP_EXIT_LOG_INSTALLED__ = true
    process.once('exit', (code) => {
      writeLine('[bootstrap] process-exit code=' + code)
      if (typeof closeSync === 'function' && typeof diagnosticFileDescriptor === 'number') {
        try {
          closeSync(diagnosticFileDescriptor)
        } catch {
          // Diagnostics must never affect shutdown.
        }
      }
    })
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      const message = error && typeof error === 'object' && 'stack' in error ? error.stack : error
      writeLine('[bootstrap] uncaught-exception origin=' + safeJson(origin) + ' error=' + safeJson(String(message)))
    })
    process.on('unhandledRejection', (reason) => {
      const message = reason && typeof reason === 'object' && 'stack' in reason ? reason.stack : reason
      writeLine('[bootstrap] unhandled-rejection error=' + safeJson(String(message)))
    })
  }
  if (mode === 'trace' && !globalThis.__ORCA_BOOTSTRAP_REQUIRE_TRACE_INSTALLED__) {
    globalThis.__ORCA_BOOTSTRAP_REQUIRE_TRACE_INSTALLED__ = true
    try {
      const Module = require('node:module')
      const originalLoad = Module._load
      const parsedTraceLimit = Number(env?.ORCA_STARTUP_DIAGNOSTICS_TRACE_LIMIT ?? 20000)
      const traceLimit = Number.isFinite(parsedTraceLimit) && parsedTraceLimit > 0 ? parsedTraceLimit : 20000
      let traceLineCount = 0
      let traceLimitReported = false
      const writeTraceLine = (message) => {
        if (traceLineCount >= traceLimit) {
          if (!traceLimitReported) {
            traceLimitReported = true
            writeLine('[bootstrap] require-trace-limit-reached limit=' + safeJson(traceLimit))
          }
          return
        }
        traceLineCount += 1
        writeLine(message)
      }
      Module._load = function (request, parent, isMain) {
        const parentName = parent && parent.filename ? parent.filename : null
        writeTraceLine('[bootstrap] require-start request=' + safeJson(request) + ' parent=' + safeJson(parentName) + ' isMain=' + safeJson(Boolean(isMain)))
        try {
          const result = Reflect.apply(originalLoad, this, arguments)
          writeTraceLine('[bootstrap] require-ok request=' + safeJson(request))
          return result
        } catch (error) {
          const message = error && typeof error === 'object' && 'stack' in error ? error.stack : error
          writeTraceLine('[bootstrap] require-error request=' + safeJson(request) + ' error=' + safeJson(String(message)))
          throw error
        }
      }
    } catch (error) {
      writeLine('[bootstrap] require-trace-install-error error=' + safeJson(String(error)))
    }
  }
})();
`
}

export function createMainProcessBootstrap(mainFileName = MAIN_PROCESS_BUNDLE_FILE): string {
  return `${createBootstrapFatalExitBanner()}${createStartupDiagnosticsBanner(mainFileName)}
try {
  // Why: macOS, Windows, and installed Linux have stable paths; AppImage FUSE paths change each run.
  const isLinuxAppImage = process.platform === 'linux' && typeof process.env.APPIMAGE === 'string' && process.env.APPIMAGE.length > 0
  if (!isLinuxAppImage) {
    const compileCacheModule = require('node:module')
    if (typeof compileCacheModule.enableCompileCache === 'function') {
      let cacheDirectory = process.env.NODE_COMPILE_CACHE
      if (typeof cacheDirectory !== 'string' || cacheDirectory.length === 0) {
        const electronApp = require('electron').app
        const path = require('node:path')
        let cacheRoot = process.env.ORCA_E2E_USER_DATA_DIR
        if (typeof cacheRoot !== 'string' || cacheRoot.length === 0) {
          const devOverride = process.env.ORCA_DEV_USER_DATA_PATH
          // Why: generated source-local storage disappears with its workspace instead of orphaning path-keyed entries in shared app data.
          cacheRoot = electronApp.isPackaged
            ? electronApp.getPath('userData')
            : typeof devOverride === 'string' && devOverride.length > 0
              ? devOverride
              : path.join(__dirname, '..', ${JSON.stringify(MAIN_PROCESS_DEVELOPMENT_CACHE_PARENT_DIRECTORY)})
        }
        cacheDirectory = path.join(cacheRoot, ${JSON.stringify(MAIN_PROCESS_COMPILE_CACHE_DIRECTORY)})
      }
      compileCacheModule.enableCompileCache(cacheDirectory)
    }
  }
} catch {
  // Why: compile caching is an optimization and must never prevent launch.
}

module.exports = require(${JSON.stringify(`./${mainFileName}`)})
`
}

export function createMainProcessBootstrapPlugin(): Plugin {
  return {
    name: 'orca-main-process-bootstrap',
    generateBundle(_options, bundle) {
      const mainChunk = bundle[MAIN_PROCESS_BUNDLE_FILE]
      if (!mainChunk || mainChunk.type !== 'chunk') {
        this.error(`Missing main-process entry chunk: ${MAIN_PROCESS_BUNDLE_FILE}`)
      }
      this.emitFile({
        type: 'asset',
        fileName: MAIN_PROCESS_BOOTSTRAP_FILE,
        source: createMainProcessBootstrap(mainChunk.fileName)
      })
    }
  }
}
