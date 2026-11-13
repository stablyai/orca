import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as nodePath from 'node:path'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_FATAL_LOG_ENV_VAR,
  BOOTSTRAP_FATAL_LOG_FILE_NAME,
  createBootstrapFatalExitBanner
} from '../../../build-plugins/bootstrap-fatal-exit-banner'

type BootstrapProcessMock = EventEmitter & {
  env: Record<string, string>
  pid: number
  exit: (code: number) => void
  exitCode?: number
}

/** Runs the banner in a bare context and raises the bootstrap fault it guards against. */
function failBootstrapWithBanner(options: {
  env: Record<string, string>
  tmpdir?: string
}): BootstrapProcessMock {
  const processMock = new EventEmitter() as BootstrapProcessMock
  processMock.env = options.env
  processMock.pid = 4242
  processMock.exit = () => {}
  const fsShim = {
    ...nodeFs,
    writeSync: (descriptor: number, data: string) => {
      if (descriptor === 2) {
        return data.length
      }
      return nodeFs.writeSync(descriptor, data)
    }
  }
  const context = {
    process: processMock,
    setImmediate: () => {},
    require: (specifier: string) => {
      if (specifier === 'node:fs') {
        return fsShim
      }
      if (specifier === 'node:path') {
        return nodePath
      }
      if (specifier === 'node:os' && options.tmpdir !== undefined) {
        return { tmpdir: () => options.tmpdir }
      }
      // Electron's own module is unreachable from a bootstrap fault this early.
      throw new Error(`unexpected require: ${specifier}`)
    }
  }

  runInNewContext(createBootstrapFatalExitBanner(), context)
  processMock.emit('uncaughtException', new Error("Cannot find module 'ws'"))
  return processMock
}

describe('Electron Vite output contract', () => {
  it('creates the parent directory an overridden log path names but does not have', () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'orca-bootstrap-fatal-'))
    const logPath = join(logDirectory, 'nested', 'diagnostics', 'fatal.log')

    try {
      const processMock = failBootstrapWithBanner({
        env: { [BOOTSTRAP_FATAL_LOG_ENV_VAR]: logPath }
      })

      expect(readFileSync(logPath, 'utf8')).toContain("Cannot find module 'ws'")
      expect(processMock.exitCode).toBe(1)
    } finally {
      rmSync(logDirectory, { recursive: true, force: true })
    }
  })

  it('falls back to the default location when the overridden log path is unwritable', () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'orca-bootstrap-fatal-'))
    const fallbackDirectory = join(logDirectory, 'fallback')

    try {
      const processMock = failBootstrapWithBanner({
        // A directory can never be opened as the log file, so the override must yield.
        env: { [BOOTSTRAP_FATAL_LOG_ENV_VAR]: logDirectory },
        tmpdir: fallbackDirectory
      })

      const recorded = readFileSync(join(fallbackDirectory, BOOTSTRAP_FATAL_LOG_FILE_NAME), 'utf8')
      expect(recorded).toContain("Cannot find module 'ws'")
      expect(processMock.exitCode).toBe(1)
    } finally {
      rmSync(logDirectory, { recursive: true, force: true })
    }
  })
})
