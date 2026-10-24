import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as nodePath from 'node:path'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { MainConfigFactory } from 'electron-vite'
import { resolveConfig } from 'vite'
import {
  DEV_BUNDLE_ID,
  DEV_HELPER_BUNDLE_ID,
  getDevHelperPlistPatches
} from './dev-electron-bundle-identity.mjs'
import {
  BOOTSTRAP_FATAL_LOG_ENV_VAR,
  BOOTSTRAP_FATAL_LOG_FILE_NAME,
  createBootstrapFatalExitBanner
} from '../build-plugins/bootstrap-fatal-exit-banner'
import { createRequire } from 'node:module'
import configureElectronVite, { electronViteConfig } from '../../electron.vite.config'
import { BOOTSTRAP_FATAL_EXIT_GUARD_KEY } from '../../src/main/startup/bootstrap-fatal-exit-guard'
import { FOREIGN_SQLITE_READER_ENTRY_FILENAME } from '../../src/main/foreign-sqlite-readers/foreign-sqlite-reader-entry-path'
import { ORCAD_CHILD_ENTRY_POINTS } from './orcad-entry-build.mjs'

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

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')

describe('Electron Vite output contract', () => {
  it('skips main maps only for explicit check builds and always keeps official release maps', async () => {
    try {
      for (const [setting, identity, expected] of [
        [undefined, undefined, 'hidden'],
        ['false', undefined, 'hidden'],
        ['1', undefined, 'hidden'],
        ['0', undefined, false],
        ['0', 'stable', 'hidden'],
        ['0', 'rc', 'hidden']
      ] as const) {
        vi.stubEnv('ORCA_CI_MAIN_SOURCEMAPS', setting)
        vi.stubEnv('ORCA_BUILD_IDENTITY', identity)
        vi.resetModules()
        const { electronViteConfig: configured } = await import('../../electron.vite.config')
        expect(configured.main?.build?.sourcemap).toBe(expected)
        expect(configured.main?.build?.minify).toBe(electronViteConfig.main?.build?.minify)
        expect(configured.main?.build?.rollupOptions?.input).toEqual(
          electronViteConfig.main?.build?.rollupOptions?.input
        )
        expect(configured.renderer?.build).toEqual(electronViteConfig.renderer?.build)
        expect(configured.preload?.build).toEqual(electronViteConfig.preload?.build)
      }
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('can skip main source maps during development without changing build output settings', () => {
    try {
      vi.stubEnv('ORCA_DEV_MAIN_SOURCEMAPS', undefined)
      const defaults = configureElectronVite({ command: 'serve', mode: 'development' })
      expect(defaults.main?.build?.sourcemap).toBe('hidden')
      expect(defaults.main?.build?.minify).toBe(false)
      vi.stubEnv('ORCA_DEV_MAIN_SOURCEMAPS', '0')
      const development = configureElectronVite({ command: 'serve', mode: 'development' })
      expect(development.main?.build?.sourcemap).toBe(false)
      expect(development.main?.build?.minify).toBe(false)
      expect(development.main?.build?.rollupOptions).toBe(
        electronViteConfig.main?.build?.rollupOptions
      )
      expect(development.renderer).toBe(electronViteConfig.renderer)
      expect(development.preload).toBe(electronViteConfig.preload)
      for (const mode of ['development', 'production']) {
        expect(configureElectronVite({ command: 'build', mode })).toBe(electronViteConfig)
      }
      expect(electronViteConfig.main?.build?.sourcemap).toBe('hidden')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("minifies main and renderer with rolldown's in-process minifier", () => {
    // Why: 'esbuild' routes every chunk through a second, undeclared transpiler.
    expect(electronViteConfig.main?.build?.minify).toBe('oxc')
    expect(electronViteConfig.renderer?.build?.minify).toBe('oxc')
    expect(electronViteConfig.main?.esbuild).toBeUndefined()
    expect(electronViteConfig.renderer?.esbuild).toBeUndefined()
  })

  it('emits hidden main source maps that packaging strips from app.asar', () => {
    // Hidden maps decode minified crash traces without the bundle referencing
    // files that the packaged app never ships.
    expect(electronViteConfig.main?.build?.sourcemap).toBe('hidden')
    expect(electronBuilderConfig.files).toContain('!out/**/*.map')
  })

  it('keeps main-process and plain-Node entries at stable CommonJS paths', () => {
    const output = electronViteConfig.main?.build?.rollupOptions?.output
    if (!output || Array.isArray(output) || typeof output.entryFileNames !== 'string') {
      throw new Error('Expected one main-process output with a filename template')
    }

    expect(output.format).toBe('cjs')
    expect(output.entryFileNames).toBe('[name].js')
    expect(output.chunkFileNames).toBe('chunks/[name]-[hash].js')

    const build = electronViteConfig.main?.build
    const input = build?.rollupOptions?.input
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Expected named main-process inputs')
    }

    const entryName = nodePath.parse(FOREIGN_SQLITE_READER_ENTRY_FILENAME).name
    expect(input[entryName]).toBe(nodePath.resolve(ORCAD_CHILD_ENTRY_POINTS.foreignSqliteReader))
    const outputFilename = output.entryFileNames.replace('[name]', entryName)
    expect(outputFilename).toBe(FOREIGN_SQLITE_READER_ENTRY_FILENAME)

    const appRoot = join(tmpdir(), 'orca-sqlite-unpack-app')
    const matcher = new FileMatcher(
      appRoot,
      join(tmpdir(), 'orca-sqlite-unpack-destination'),
      (value: string) => value,
      electronBuilderConfig.asarUnpack
    )
    const relativeOutDir = nodePath.relative(
      nodePath.resolve('.'),
      nodePath.resolve(build?.outDir ?? join('out', 'main'))
    )
    const outputPath = join(appRoot, relativeOutDir, outputFilename)
    expect(matcher.createFilter()(outputPath, { isDirectory: () => false })).toBe(true)
  })

  it('keeps CLI main imports unpacked at stable paths', () => {
    const input = electronViteConfig.main?.build?.rollupOptions?.input
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Expected named main-process inputs')
    }

    for (const name of [
      'macos-tree-clone',
      'orca-profiles/profile-index-store',
      'persistence/profile-state/profile-state-access',
      'persistence/profile-state/profile-state-active-location',
      'persistence/profile-state/profile-state-backup-path',
      'persistence/profile-state/profile-state-database-recovery',
      'persistence/profile-state/profile-state-domain-reader',
      'persistence/profile-state/legacy-json/profile-state-export-path',
      'persistence/profile-state/profile-state-offline-settings',
      'persistence/profile-state/legacy-json/profile-state-recovery',
      'persistence/profile-state/profile-state-recovery-command',
      'persistence/profile-state/profile-state-storage-classification',
      'skills/bundled-skill-install/cli-entry',
      'startup/http1-compatibility-marker'
    ]) {
      expect(input).toHaveProperty(name)
    }
    expect(electronBuilderConfig.asarUnpack).toContain('out/main/macos-tree-clone.js')
    expect(electronBuilderConfig.asarUnpack).toContain('out/main/asar-transparent-fs.js')
    expect(electronBuilderConfig.asarUnpack).toContain('out/main/persistence/profile-state/**')
    expect(electronBuilderConfig.asarUnpack).toContain(
      'out/main/orca-profiles/profile-index-store.js'
    )
    expect(electronBuilderConfig.asarUnpack).toContain(
      'out/main/startup/http1-compatibility-marker.js'
    )
    expect(electronBuilderConfig.asarUnpack).toContain(
      'out/main/skills/bundled-skill-install/cli-entry.js'
    )
  })

  it('externalizes packaged dependencies but bundles self-contained main dependencies', async () => {
    const main = await new MainConfigFactory(electronViteConfig.main ?? {}, {}, {}).build()
    const resolved = await resolveConfig({ ...main, configFile: false }, 'build')
    const patterns = resolved.build.rolldownOptions.external
    if (!Array.isArray(patterns)) {
      throw new Error('Expected mergeable main-process external patterns')
    }
    const external = (source: string) =>
      patterns.some((pattern) =>
        typeof pattern === 'string' ? pattern === source : pattern.test(source)
      )

    expect(external('node-pty')).toBe(true)
    expect(external('@parcel/watcher')).toBe(true)
    expect(external('electron')).toBe(true)
    expect(external('electron/common')).toBe(true)
    expect(external('fs')).toBe(true)
    expect(external('node:fs')).toBe(true)
    expect(external('@orca/process-host')).toBe(true)
    expect(external('@orca/process-host/spawn-observer')).toBe(true)
    expect(external('@xterm/headless')).toBe(false)
    expect(external('@xterm/addon-serialize')).toBe(false)
    expect(external('tldts')).toBe(false)
    expect(external('zod')).toBe(false)
    expect(external('smol-toml')).toBe(false)
    expect(external('smol-toml/package.json')).toBe(false)
    expect(external('@noble/hashes/blake3')).toBe(false)
    expect(external('@noble/hashes/utils')).toBe(false)
    expect(electronViteConfig.main?.build?.externalizeDeps?.exclude).toContain('tldts')
    expect(electronViteConfig.main?.build?.externalizeDeps?.exclude).toContain('zod')
    expect(electronViteConfig.main?.build?.externalizeDeps?.exclude).toContain('smol-toml')
  })

  it('bundles validation dependencies used by the sandboxed preload', () => {
    expect(electronViteConfig.preload?.build?.externalizeDeps?.exclude).toContain('zod')
  })

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

  it('isolates renderer entry side effects behind strict facades', () => {
    expect(electronViteConfig.renderer?.build?.rollupOptions?.preserveEntrySignatures).toBe(
      'strict'
    )
  })

  it('gives the dev terminal daemon helper the TCC identity watched by Orca', () => {
    // Asserted on the values rather than the source text: the ids moved into
    // dev-electron-bundle-identity.mjs so every dev bundle signs to one cdhash.
    expect(DEV_HELPER_BUNDLE_ID).toBe(`${DEV_BUNDLE_ID}.helper`)
    expect(getDevHelperPlistPatches()).toEqual([
      { key: 'CFBundleIdentifier', value: DEV_HELPER_BUNDLE_ID }
    ])
  })
})
