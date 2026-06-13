import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Why: the telemetry transport is gated by two compile-time constants that
// only the official CI release workflow sets. Contributor / `pnpm dev` /
// third-party rebuilds must substitute literal `null` at these sites so
// `IS_OFFICIAL_BUILD` in `src/main/telemetry/client.ts` evaluates `false`
// at module load and the track() wrapper short-circuits to console-mirror.
// The substitution happens at compile time — there is no runtime env-var
// fallback — so a curious contributor cannot spoof transmission with a
// shell export.
//
// CI injects real values via GitHub Actions secrets
// (ORCA_BUILD_IDENTITY='stable' | 'rc', ORCA_POSTHOG_WRITE_KEY=phc_...);
// every other build path resolves these env vars to undefined, which the
// JSON.stringify below folds to the literal `null`. Ambient declarations
// for the two constants live in `src/types/build-constants.d.ts`.
const orcaBuildIdentity = process.env.ORCA_BUILD_IDENTITY
const ORCA_BUILD_IDENTITY_LITERAL =
  orcaBuildIdentity === 'stable' || orcaBuildIdentity === 'rc'
    ? JSON.stringify(orcaBuildIdentity)
    : 'null'
const orcaPostHogWriteKey = process.env.ORCA_POSTHOG_WRITE_KEY
const ORCA_POSTHOG_WRITE_KEY_LITERAL =
  typeof orcaPostHogWriteKey === 'string' && orcaPostHogWriteKey.length > 0
    ? JSON.stringify(orcaPostHogWriteKey)
    : 'null'
const orcaDiagnosticsTokenUrl = process.env.ORCA_DIAGNOSTICS_TOKEN_URL
const ORCA_DIAGNOSTICS_TOKEN_URL_LITERAL =
  typeof orcaDiagnosticsTokenUrl === 'string' && orcaDiagnosticsTokenUrl.length > 0
    ? JSON.stringify(orcaDiagnosticsTokenUrl)
    : 'null'

function createStartupDiagnosticsBanner(chunkName: string): string {
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

function createStartupDiagnosticsBootstrapPlugin() {
  return {
    name: 'orca-startup-diagnostics-bootstrap',
    generateBundle(_options, bundle) {
      const mainChunk = bundle['index.js']
      if (!mainChunk || mainChunk.type !== 'chunk') {
        return
      }

      // Why: source-level startup diagnostics run after Rollup's generated
      // prelude and require() list. Mutate the final emitted chunk so macOS
      // launch failures can identify the earliest JS boundary reached.
      mainChunk.code = createStartupDiagnosticsBanner(mainChunk.fileName) + mainChunk.code
    }
  }
}

export default defineConfig({
  main: {
    build: {
      // Why: daemon-entry.js is asar-unpacked so child_process.fork() can
      // execute it from disk. Node's module resolution from the unpacked
      // directory cannot reach into app.asar, so pure-JS dependencies used
      // by the daemon must be bundled rather than externalized.
      externalizeDeps: {
        exclude: ['@xterm/headless', '@xterm/addon-serialize']
      },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'daemon-entry': resolve('src/main/daemon/daemon-entry.ts'),
          'computer-sidecar': resolve('src/main/computer/sidecar-entry.ts'),
          'stt-worker': resolve('src/main/speech/stt-worker.ts'),
          'warp-theme-parser-worker': resolve('src/main/warp-themes/warp-theme-parser-worker.ts'),
          // Why: electron-vite cleans out/main in dev. The dev CLI imports
          // this path for `orca agent hooks ...`, so it must survive rebuilds.
          'agent-hooks/managed-agent-hook-controls': resolve(
            'src/main/agent-hooks/managed-agent-hook-controls.ts'
          )
        },
        plugins: [createStartupDiagnosticsBootstrapPlugin()]
      }
    },
    // Why: compile-time substitution for the telemetry gate. See the block
    // above for the full rationale.
    define: {
      ORCA_BUILD_IDENTITY: ORCA_BUILD_IDENTITY_LITERAL,
      ORCA_POSTHOG_WRITE_KEY: ORCA_POSTHOG_WRITE_KEY_LITERAL,
      ORCA_DIAGNOSTICS_TOKEN_URL: ORCA_DIAGNOSTICS_TOKEN_URL_LITERAL
    },
    // Why: @xterm/headless declares "exports": null in package.json, which
    // prevents Vite's default resolver from finding the CJS entry. Point
    // directly at the published main file so the bundler can inline it.
    resolve: {
      alias: {
        '@xterm/headless': resolve('node_modules/@xterm/headless/lib-headless/xterm-headless.js'),
        '@xterm/addon-serialize': resolve(
          'node_modules/@xterm/addon-serialize/lib/addon-serialize.js'
        )
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ['@electron-toolkit/preload']
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    worker: {
      format: 'es'
    }
  }
})
