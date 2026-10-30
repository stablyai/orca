import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin, Rollup } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLI_MAIN_ENTRY_NAMES,
  createPlainNodeEntryGuardPlugin,
  GUARDED_ENTRY_NAMES
} from '../build-plugins/plain-node-entry-guard'

let outputDir: string | undefined

afterEach(() => {
  if (outputDir) {
    rmSync(outputDir, { recursive: true, force: true })
    outputDir = undefined
  }
})

function createOutputDir(): string {
  outputDir = mkdtempSync(join(tmpdir(), 'orca-plain-node-entry-guard-'))
  return outputDir
}

function createBundle(code = ''): Rollup.OutputBundle {
  return {
    'daemon-entry.js': {
      type: 'chunk',
      code,
      dynamicImports: [],
      fileName: 'daemon-entry.js',
      imports: [],
      isEntry: true,
      name: 'daemon-entry'
    } as Rollup.OutputChunk
  }
}

function runWriteBundle(plugin: Plugin, dir: string, code = ''): void {
  const hook = plugin.writeBundle
  if (typeof hook !== 'function') {
    throw new Error('Expected writeBundle hook')
  }
  hook.call(
    { meta: { watchMode: false } } as never,
    { dir } as Rollup.NormalizedOutputOptions,
    createBundle(code)
  )
}

async function runCloseBundle(plugin: Plugin): Promise<void> {
  const hook = plugin.closeBundle
  if (typeof hook !== 'function') {
    throw new Error('Expected closeBundle hook')
  }
  await hook.call({} as never)
}

describe('plain Node entry guard', () => {
  it('smoke-loads the daemon after output files are written', async () => {
    const dir = createOutputDir()
    const plugin = createPlainNodeEntryGuardPlugin()

    expect(() => runWriteBundle(plugin, dir)).not.toThrow()
    writeFileSync(
      join(dir, 'daemon-entry.js'),
      'console.error("Usage: daemon-entry <socket>"); process.exit(1)\n'
    )

    await expect(runCloseBundle(plugin)).resolves.toBeUndefined()
  })

  it('runs the deferred smoke from closeBundle', async () => {
    const dir = createOutputDir()
    const plugin = createPlainNodeEntryGuardPlugin()

    runWriteBundle(plugin, dir)
    writeFileSync(join(dir, 'daemon-entry.js'), "require('./missing-module')\n")

    await expect(runCloseBundle(plugin)).rejects.toThrow('failed to load under plain Node')
  })

  it('rejects Electron imports during the static bundle scan', () => {
    const plugin = createPlainNodeEntryGuardPlugin()

    expect(() => runWriteBundle(plugin, createOutputDir(), 'require("electron")')).toThrow(
      'requires electron'
    )
  })

  it('rejects Electron subpath requires', () => {
    const plugin = createPlainNodeEntryGuardPlugin()

    expect(() => runWriteBundle(plugin, createOutputDir(), 'require("electron/main")')).toThrow(
      'requires electron'
    )
  })

  it('rejects a daemon-graph package the relocated Windows daemon-host does not mirror', () => {
    const plugin = createPlainNodeEntryGuardPlugin()

    expect(() =>
      runWriteBundle(plugin, createOutputDir(), 'const nacl = require(`tweetnacl`)')
    ).toThrow('does not mirror')
    expect(() =>
      runWriteBundle(
        plugin,
        createOutputDir(),
        'require("node:fs"); require("path"); require("@orca/process-host/spawn-observer"); require("node-pty")'
      )
    ).not.toThrow()
  })

  it('fails the smoke when the daemon exits zero on an empty argv', async () => {
    const dir = createOutputDir()
    const plugin = createPlainNodeEntryGuardPlugin()

    runWriteBundle(plugin, dir)
    writeFileSync(join(dir, 'daemon-entry.js'), 'console.error("Usage: daemon-entry <socket>")\n')

    await expect(runCloseBundle(plugin)).rejects.toThrow('did not reject an empty argv')
  })

  // daemon-entry traps SIGTERM; smoke timeout must escalate to SIGKILL or spawnSync can wait forever.
  it('kills a daemon that traps SIGTERM and never exits', async () => {
    const dir = createOutputDir()
    const plugin = createPlainNodeEntryGuardPlugin({ timeoutMs: 250, killGraceMs: 250 })

    runWriteBundle(plugin, dir)
    writeFileSync(
      join(dir, 'daemon-entry.js'),
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n"
    )

    await expect(runCloseBundle(plugin)).rejects.toThrow('did not exit within 250ms')
  }, 10_000)
})

// Fail if entry is renamed: writeBundle otherwise skips missing input and silently drops its guard.
describe('guarded entry names', () => {
  function runBuildStart(plugin: Plugin, input: unknown): void {
    const hook = plugin.buildStart
    if (typeof hook !== 'function') {
      throw new Error('Expected buildStart hook')
    }
    hook.call({} as never, { input } as Rollup.NormalizedInputOptions)
  }

  it('rejects a guarded name that is no longer a rollup input', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const input = Object.fromEntries(
      GUARDED_ENTRY_NAMES.filter((name) => name !== 'stt-worker').map((name) => [
        name,
        `${name}.ts`
      ])
    )

    expect(() => runBuildStart(plugin, input)).toThrow('"stt-worker"')
  })

  it('passes when every guarded name is a rollup input', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const input = Object.fromEntries(GUARDED_ENTRY_NAMES.map((name) => [name, `${name}.ts`]))

    expect(() => runBuildStart(plugin, input)).not.toThrow()
  })
})

// Electron is unavailable in main-process workers too (#11161); transitive imports can kill startup despite entry-local electron-free comments.
describe('CLI and worker thread entry guard', () => {
  function runEntryWriteBundle(
    plugin: Plugin,
    bundle: Rollup.OutputBundle,
    watchMode = false
  ): void {
    const hook = plugin.writeBundle
    if (typeof hook !== 'function') {
      throw new Error('Expected writeBundle hook')
    }
    hook.call(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This hook reads only meta.watchMode from its context.
      { meta: { watchMode } } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This hook reads only dir from the output options.
      { dir: outputDir ?? createOutputDir() } as Rollup.NormalizedOutputOptions,
      bundle
    )
  }

  function entryChunk(name: string, code: string, imports: string[] = []): Rollup.OutputChunk {
    return {
      type: 'chunk',
      code,
      dynamicImports: [],
      fileName: `${name}.js`,
      imports,
      isEntry: true,
      name
    } as Rollup.OutputChunk
  }

  function countElectronRequireScans(run: () => void): number {
    const pattern = /require\(\s*["'`]electron(?:\/[^"'`]+)?["'`]\s*\)/
    const originalTest = RegExp.prototype.test
    let scans = 0
    const spy = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (
      this: RegExp,
      value: string
    ) {
      if (this.source === pattern.source) {
        scans += 1
      }
      return originalTest.call(this, value)
    })
    try {
      run()
    } finally {
      spy.mockRestore()
    }
    return scans
  }

  it('scans shared code once across every guarded entry', () => {
    const shared = entryChunk('shared', 'require("node:fs")')
    shared.isEntry = false
    const bundle: Rollup.OutputBundle = { [shared.fileName]: shared }
    for (const name of GUARDED_ENTRY_NAMES) {
      const entry = entryChunk(name, `require("./shared.js"); // ${name}`, [shared.fileName])
      bundle[entry.fileName] = entry
    }
    const snapshot = structuredClone(bundle)

    const scans = countElectronRequireScans(() => {
      runEntryWriteBundle(createPlainNodeEntryGuardPlugin(), bundle)
    })

    expect(bundle).toEqual(snapshot)
    expect(scans).toBe(GUARDED_ENTRY_NAMES.length + 1)
  })

  it('does not retain a successful scan across output bundles', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const entry = entryChunk('stt-worker', 'require("node:fs")')
    const bundle: Rollup.OutputBundle = { [entry.fileName]: entry }
    const scans = countElectronRequireScans(() => {
      runEntryWriteBundle(plugin, bundle)
      runEntryWriteBundle(plugin, bundle)
    })
    expect(scans).toBe(2)

    entry.code = 'require("electron/main")'
    expect(() => runEntryWriteBundle(plugin, bundle)).toThrow(
      '[plain-node-entry-guard] "stt-worker" reaches chunk "stt-worker.js" that requires electron. '
    )
  })

  it('still reads changed code on the same chunk within one bundle scan', () => {
    const first = entryChunk('stt-worker', 'require("node:fs")')
    const second = entryChunk('warp-theme-parser-worker', 'require("node:fs")')
    const shared = entryChunk('shared', '')
    shared.isEntry = false
    let reads = 0
    Object.defineProperty(shared, 'code', {
      get: () => (++reads === 1 ? 'require("node:fs")' : 'require("electron")')
    })
    first.imports = [shared.fileName]
    second.dynamicImports = [shared.fileName]
    const bundle: Rollup.OutputBundle = {
      [first.fileName]: first,
      [second.fileName]: second,
      [shared.fileName]: shared
    }

    expect(() => runEntryWriteBundle(createPlainNodeEntryGuardPlugin(), bundle)).toThrow(
      '[plain-node-entry-guard] "warp-theme-parser-worker" reaches chunk "shared.js"'
    )
    expect(reads).toBe(2)
  })

  it('keeps watch mode free of entry scanning', () => {
    const entry = entryChunk('stt-worker', 'require("electron")')
    const bundle: Rollup.OutputBundle = { [entry.fileName]: entry }
    const scans = countElectronRequireScans(() => {
      runEntryWriteBundle(createPlainNodeEntryGuardPlugin(), bundle, true)
    })
    expect(scans).toBe(0)
  })

  it.each(CLI_MAIN_ENTRY_NAMES)('rejects direct and transitive Electron imports in %s', (name) => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const entry = entryChunk(name, 'require("electron")')
    const bundle: Rollup.OutputBundle = { [entry.fileName]: entry }
    expect(() => runEntryWriteBundle(plugin, bundle)).toThrow('requires electron')

    entry.code = ''
    const shared = entryChunk('shared', 'require("electron/main")')
    shared.isEntry = false
    bundle[shared.fileName] = shared
    for (const edge of ['imports', 'dynamicImports'] as const) {
      entry[edge] = [shared.fileName]
      expect(() => runEntryWriteBundle(plugin, bundle)).toThrow('requires electron')
      entry[edge] = []
    }

    shared.code = 'require("node:fs")'
    entry.imports = [shared.fileName]
    expect(() => runEntryWriteBundle(plugin, bundle)).not.toThrow()
  })

  it('rejects an Electron require reachable from a worker entry', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const bundle: Rollup.OutputBundle = {
      'port-scan-command-worker-entry.js': entryChunk(
        'port-scan-command-worker-entry',
        'require("electron")'
      )
    }

    expect(() => runEntryWriteBundle(plugin, bundle)).toThrow('requires electron')
  })

  it('names the worker-thread runtime so the failure is actionable', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const bundle: Rollup.OutputBundle = {
      'stt-worker.js': entryChunk('stt-worker', 'require("electron")')
    }

    expect(() => runEntryWriteBundle(plugin, bundle)).toThrow('runs as a worker thread')
  })

  // Exercise transitive shared-chunk imports into the electron client, where direct-import checks miss startup failures.
  it('follows shared chunks out of a worker entry', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const bundle: Rollup.OutputBundle = {
      'foreign-sqlite-reader-entry.js': entryChunk(
        'foreign-sqlite-reader-entry',
        'require("./chunks/shared.js")',
        ['chunks/shared.js']
      ),
      'chunks/shared.js': {
        type: 'chunk',
        code: 'require("electron")',
        dynamicImports: [],
        fileName: 'chunks/shared.js',
        imports: [],
        isEntry: false,
        name: 'shared'
      } as Rollup.OutputChunk
    }

    expect(() => runEntryWriteBundle(plugin, bundle)).toThrow('chunks/shared.js')
  })

  it('passes a clean worker entry', () => {
    const plugin = createPlainNodeEntryGuardPlugin()
    const bundle: Rollup.OutputBundle = {
      'warp-theme-parser-worker.js': entryChunk(
        'warp-theme-parser-worker',
        'require("node:worker_threads")'
      )
    }

    expect(() => runEntryWriteBundle(plugin, bundle)).not.toThrow()
  })
})
