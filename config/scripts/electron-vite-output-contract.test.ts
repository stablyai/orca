import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createBootstrapFatalExitBanner, electronViteConfig } from '../../electron.vite.config'
import { BOOTSTRAP_FATAL_EXIT_GUARD_KEY } from '../../src/main/startup/bootstrap-fatal-exit-guard'

const targetConfig = readFileSync('config/electron-vite-target.config.ts', 'utf8')
const devRunner = readFileSync('config/scripts/run-electron-vite-dev.mjs', 'utf8')

describe('Electron Vite output contract', () => {
  it('keeps main-process and plain-Node entries at stable CommonJS paths', () => {
    const output = electronViteConfig.main?.build?.rollupOptions?.output
    if (!output || Array.isArray(output)) {
      throw new Error('Expected one main-process output')
    }

    expect(output.format).toBe('cjs')
    expect(output.entryFileNames).toBe('[name].js')
    expect(output.chunkFileNames).toBe('chunks/[name]-[hash].js')
  })

  it('externalizes packaged dependencies but bundles the daemon xterm graph', () => {
    const external = electronViteConfig.main?.build?.rollupOptions?.external
    if (typeof external !== 'function') {
      throw new Error('Expected main-process external predicate')
    }

    expect(external('node-pty', undefined, false)).toBe(true)
    expect(external('@parcel/watcher', undefined, false)).toBe(true)
    expect(external('electron', undefined, false)).toBe(true)
    expect(external('node:fs', undefined, false)).toBe(true)
    expect(external('@xterm/headless', undefined, false)).toBe(false)
    expect(external('@xterm/addon-serialize', undefined, false)).toBe(false)
    expect(external('zod', undefined, false)).toBe(false)
    expect(electronViteConfig.main?.build?.externalizeDeps?.exclude).toContain('zod')
  })

  it('exits when a static import fails before source error guards load', () => {
    const processMock = new EventEmitter() as EventEmitter & {
      exit: (code: number) => void
      exitCode?: number
    }
    let scheduledExit: (() => void) | null = null
    let exitedWith: number | null = null
    processMock.exit = (code) => {
      exitedWith = code
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
  })

  it('isolates renderer entry side effects behind strict facades', () => {
    expect(electronViteConfig.renderer?.build?.rollupOptions?.preserveEntrySignatures).toBe(
      'strict'
    )
  })

  it('rejects prototype properties as build targets', () => {
    expect(targetConfig).toContain('Object.prototype.hasOwnProperty.call(configByTarget, target)')
  })

  it('gives the dev terminal daemon helper the TCC identity watched by Orca', () => {
    expect(devRunner).toContain('const helperBundleId = `${bundleId}.helper`')
    expect(devRunner).toContain("'Electron Helper.app',")
    expect(devRunner).toContain(
      "setPlistValue(helperPlistPath, 'CFBundleIdentifier', helperBundleId)"
    )
  })
})
