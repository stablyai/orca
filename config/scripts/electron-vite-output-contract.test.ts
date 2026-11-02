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
} from '../build-plugins/bootstrap-fatal-exit-banner'
import { BOOTSTRAP_FATAL_EXIT_GUARD_KEY } from '../../src/main/startup/bootstrap-fatal-exit-guard'

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
  stderrWrites?: string[]
}): BootstrapProcessMock {
  const processMock = new EventEmitter() as BootstrapProcessMock
  processMock.env = options.env
  processMock.pid = 4242
  processMock.exit = () => {}
  const fsShim = {
    ...nodeFs,
    writeSync: (descriptor: number, data: string) => {
      if (descriptor === 2) {
        options.stderrWrites?.push(data)
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
  it('exits when a static import fails before source error guards load', () => {
    const processMock = new EventEmitter() as EventEmitter & {
      exit: (code: number) => void
      exitCode?: number
      stderr: { write: (chunk: string) => boolean }
    }
    let scheduledExit: (() => void) | null = null
    let exitedWith: number | null = null
    const stderrWrites: string[] = []
    processMock.exit = (code) => {
      exitedWith = code
    }
    processMock.stderr = {
      write: (chunk) => {
        stderrWrites.push(chunk)
        return true
      }
    }
    const context = {
      process: processMock,
      setImmediate: (callback: () => void) => {
        scheduledExit = callback
      }
    }

    runInNewContext(createBootstrapFatalExitBanner(), context)
    processMock.emit('uncaughtException', new Error("Cannot find module 'zod'"))

    expect(processMock.exitCode).toBe(1)
    expect(scheduledExit).not.toBeNull()
    scheduledExit?.()
    expect(exitedWith).toBe(1)
    expect(context).toHaveProperty(BOOTSTRAP_FATAL_EXIT_GUARD_KEY)
    expect(stderrWrites.join('')).toContain("Cannot find module 'zod'")
  })

  it('records the bootstrap failure it exits on, since the guard hides Electron dialog', () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'orca-bootstrap-fatal-'))
    const logPath = join(logDirectory, 'fatal.log')
    const stderrWrites: string[] = []

    try {
      const processMock = failBootstrapWithBanner({
        env: { [BOOTSTRAP_FATAL_LOG_ENV_VAR]: logPath },
        stderrWrites
      })

      expect(stderrWrites.join('')).toContain("Cannot find module 'ws'")
      const recorded = readFileSync(logPath, 'utf8')
      expect(recorded).toContain("Cannot find module 'ws'")
      expect(recorded).toContain('pid=4242')
      expect(processMock.exitCode).toBe(1)
    } finally {
      rmSync(logDirectory, { recursive: true, force: true })
    }
  })

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
