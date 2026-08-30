import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'
import { resolveElectronProbeLaunch } from '../main/browser/electron-probe-display-launch'

/**
 * What a renderer consumer actually receives, measured across a real `contextBridge`.
 *
 * The boundary rethrows the object `ipcRenderer.invoke` rejected with, so inside preload the
 * rejection keeps its identity, its properties and its original stack. None of that reaches the
 * renderer: `contextBridge` copies the value, and a copy is a fresh plain `Error`. Unit tests that
 * stop at the preload side cannot see this, which is why the guarantee was overstated — so this
 * file drives the real binary and asserts the renderer's view, including the parts that are lost.
 *
 * The identity and own-property assertions describe the bridge, not the strip, and would hold with
 * the boundary deleted. They are here to keep the *claim* honest, not to pin the fix; the strip is
 * pinned by the message and stack assertions, which the `unstripped` control moves.
 */
const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

type ErrorView = {
  isError: boolean
  ctorName: string
  name: string
  message: string
  ownKeys: string[]
  stackFirstLine: string
  code?: string
}

type FixtureResult = {
  preloadStripped: ErrorView
  preloadCarriesOwnProperties: ErrorView
  rendererStripped: ErrorView
  rendererUnstripped: ErrorView
  rendererCarriesOwnProperties: ErrorView
  sameObjectAcrossTwoRejections: boolean
  mutatingOneCopyLeaksToTheOther: boolean
}

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

/** `sandbox: true` matches `createMainWindow`, and a sandboxed preload may only require `electron`. */
function preloadEntry(boundaryPath: string): string {
  return `
import { contextBridge, ipcRenderer } from 'electron'
import { invoke } from ${JSON.stringify(boundaryPath)}

const view = (e) => ({
  isError: e instanceof Error,
  ctorName: (e && e.constructor && e.constructor.name) || '',
  name: (e && e.name) || '',
  message: (e && e.message) || '',
  ownKeys: e && typeof e === 'object' ? Object.getOwnPropertyNames(e).sort() : [],
  stackFirstLine: e && e.stack ? String(e.stack).split('\\n')[0] : '',
  code: e && e.code
})

const record = {}

// The real boundary, on a channel whose handler rejects with a readable reason.
const stripped = invoke('probe:reject').catch((rejection) => {
  record.preloadStripped = view(rejection)
  throw rejection
})

// Control: the same handler reached without the boundary, so the envelope is still on the message.
const unstripped = ipcRenderer.invoke('probe:reject-control')

// A preload-constructed error carrying own properties, to characterise the bridge itself.
class BoundaryProbeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BoundaryProbeError'
    this.code = 'E_PROBE'
  }
}
const carrier = new BoundaryProbeError('carries own properties')
record.preloadCarriesOwnProperties = view(carrier)

// One object, rejected twice: the renderer sees two copies or one reference.
const shared = new Error('rejected twice')

contextBridge.exposeInMainWorld('probe', {
  stripped: () => stripped,
  unstripped: () => unstripped,
  carrier: () => Promise.reject(carrier),
  sharedFirst: () => Promise.reject(shared),
  sharedSecond: () => Promise.reject(shared),
  record: () => record
})
`
}

const RENDERER_PROBE = `
const view = (e) => ({
  isError: e instanceof Error,
  ctorName: (e && e.constructor && e.constructor.name) || '',
  name: (e && e.name) || '',
  message: (e && e.message) || '',
  ownKeys: e && typeof e === 'object' ? Object.getOwnPropertyNames(e).sort() : [],
  stackFirstLine: e && e.stack ? String(e.stack).split('\\n')[0] : '',
  code: e && e.code
})
const rejection = async (call) => {
  try {
    await call()
  } catch (caught) {
    return caught
  }
  throw new Error('expected a rejection')
}
window.__probe = async () => {
  const stripped = await rejection(() => window.probe.stripped())
  const unstripped = await rejection(() => window.probe.unstripped())
  const carrier = await rejection(() => window.probe.carrier())
  const first = await rejection(() => window.probe.sharedFirst())
  const second = await rejection(() => window.probe.sharedSecond())
  first.message = 'mutated in the renderer'
  return {
    ...window.probe.record(),
    rendererStripped: view(stripped),
    rendererUnstripped: view(unstripped),
    rendererCarriesOwnProperties: view(carrier),
    sameObjectAcrossTwoRejections: first === second,
    mutatingOneCopyLeaksToTheOther: second.message === 'mutated in the renderer'
  }
}
`

function fixtureMain(paths: { htmlPath: string; preloadPath: string; resultPath: string }): string {
  return `
const { app, BrowserWindow, ipcMain } = require('electron')
const { writeFileSync } = require('node:fs')

class HandlerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HandlerError'
    this.code = 'E_HANDLER'
  }
}
const reject = () => {
  throw new HandlerError('Host key verification failed')
}
ipcMain.handle('probe:reject', reject)
ipcMain.handle('probe:reject-control', reject)

const timeout = setTimeout(() => {
  writeFileSync(${JSON.stringify(paths.resultPath)}, JSON.stringify({ error: 'fixture timeout' }))
  process.exit(1)
}, 30000)

app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: ${JSON.stringify(paths.preloadPath)},
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    await window.loadFile(${JSON.stringify(paths.htmlPath)})
    const result = await window.webContents.executeJavaScript('window.__probe()')
    clearTimeout(timeout)
    writeFileSync(${JSON.stringify(paths.resultPath)}, JSON.stringify(result))
    app.exit(0)
  } catch (error) {
    clearTimeout(timeout)
    writeFileSync(
      ${JSON.stringify(paths.resultPath)},
      JSON.stringify({ error: String(error && error.stack ? error.stack : error) })
    )
    app.exit(1)
  }
})
`
}

async function runFixture(): Promise<FixtureResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-ipc-boundary-bridge-'))
  fixtureRoots.push(root)
  const preloadSource = join(root, 'preload-entry.ts')
  const htmlPath = join(root, 'index.html')
  const mainPath = join(root, 'main.cjs')
  const resultPath = join(root, 'result.json')

  writeFileSync(preloadSource, preloadEntry(join(process.cwd(), 'src/preload/ipc-invoke-boundary')))
  writeFileSync(htmlPath, `<!doctype html><body><script>${RENDERER_PROBE}</script></body>`)
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      // The fixture asserts on a constructor name, which minification would rewrite.
      minify: false,
      lib: {
        entry: preloadSource,
        formats: ['cjs'],
        fileName: () => 'preload.cjs',
        name: 'OrcaIpcInvokeBoundaryFixture'
      },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron'] }
    }
  })
  writeFileSync(
    mainPath,
    fixtureMain({ htmlPath, preloadPath: join(root, 'preload.cjs'), resultPath })
  )

  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const electronArgs = [mainPath, `--user-data-dir=${join(root, 'profile')}`]
  const { executable, args } = resolveElectronProbeLaunch({
    electronBinary,
    electronArgs,
    platform: process.platform,
    display: env.DISPLAY
  })
  const run = spawnSync(executable, args, { encoding: 'utf8', env, timeout: 60_000 })
  const rawResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${rawResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  return JSON.parse(rawResult) as FixtureResult
}

describe('the stripped rejection as a renderer consumer receives it', () => {
  it('arrives as an Error carrying the reason, with the envelope only in the preload-side stack', async () => {
    const result = await runFixture()

    // What the renderer can rely on.
    expect(result.rendererStripped.isError).toBe(true)
    expect(result.rendererStripped.message).toBe('Host key verification failed')

    // The control proves the message and stack assertions above move when the strip does not run.
    expect(result.rendererUnstripped.message).toBe(
      "Error invoking remote method 'probe:reject-control': HandlerError: Host key verification failed"
    )
    expect(result.rendererUnstripped.stackFirstLine).toContain('Error invoking remote method')

    // The renderer's stack is regenerated from the message, so it echoes the reason, not the
    // envelope. The wrapped form survives on the preload side, which is where it is logged.
    expect(result.rendererStripped.stackFirstLine).toBe('Error: Host key verification failed')
    expect(result.preloadStripped.stackFirstLine).toContain('Error invoking remote method')
  })

  it('is a copy: prototype, own properties and object identity do not cross the bridge', async () => {
    const result = await runFixture()

    // Preload holds a subclass with an own `code`; the renderer receives neither.
    expect(result.preloadCarriesOwnProperties.ctorName).toBe('BoundaryProbeError')
    expect(result.preloadCarriesOwnProperties.code).toBe('E_PROBE')
    expect(result.preloadCarriesOwnProperties.ownKeys).toContain('code')

    expect(result.rendererCarriesOwnProperties.isError).toBe(true)
    expect(result.rendererCarriesOwnProperties.ctorName).toBe('Error')
    expect(result.rendererCarriesOwnProperties.name).toBe('Error')
    expect(result.rendererCarriesOwnProperties.code).toBeUndefined()
    expect(result.rendererCarriesOwnProperties.ownKeys).toEqual(['message', 'stack'])

    // One preload object, rejected twice, arrives as two unrelated renderer objects.
    expect(result.sameObjectAcrossTwoRejections).toBe(false)
    expect(result.mutatingOneCopyLeaksToTheOther).toBe(false)

    // An IPC rejection has nothing else to lose: it reaches the boundary already flattened.
    expect(result.preloadStripped.ctorName).toBe('Error')
    expect(result.preloadStripped.ownKeys).toEqual(['message', 'stack'])
  })
})
