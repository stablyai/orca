import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveElectronProbeLaunch } from '../browser/electron-probe-display-launch'

const electronBinary: unknown = createRequire(import.meta.url)('electron')

// Why: stubbing showErrorBox keeps the pre-fix run off the desktop; Electron's handler still never
// exits after calling it, so the child stays resident exactly as it does behind the real dialog.
const fixtureMain = String.raw`
const { app, dialog } = require('electron')
const { writeFileSync } = require('node:fs')
const [guardPath, dialogMarkerPath] = process.argv.slice(2)
dialog.showErrorBox = () => writeFileSync(dialogMarkerPath, 'shown')
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
require(guardPath).installUncaughtPipeErrorGuard()
app.whenReady().then(() => {
  setTimeout(() => {
    throw new Error('fatal-exit fixture')
  }, 50)
})
`

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    root = null
  }
})

describe('main-process uncaught exception guard under Electron', () => {
  it('exits with code 1 instead of stalling behind Electron’s error dialog', async () => {
    if (typeof electronBinary !== 'string') {
      throw new Error('electron package did not resolve to a binary path')
    }
    root = mkdtempSync(join(tmpdir(), 'orca-fatal-exit-'))
    const guardPath = join(root, 'guard.cjs')
    const mainPath = join(root, 'main.cjs')
    const dialogMarkerPath = join(root, 'dialog-shown')
    await build({
      entryPoints: [join(__dirname, 'main-process-error-guards.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: guardPath,
      logLevel: 'silent'
    })
    writeFileSync(mainPath, fixtureMain)

    const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
    const { executable, args } = resolveElectronProbeLaunch({
      electronBinary,
      electronArgs: [
        mainPath,
        guardPath,
        dialogMarkerPath,
        `--user-data-dir=${join(root, 'profile')}`
      ],
      platform: process.platform,
      display: env.DISPLAY
    })
    const child = spawn(executable, args, {
      detached: process.platform !== 'win32',
      env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let output = ''
    child.stdout?.on('data', (chunk) => (output += String(chunk)))
    child.stderr?.on('data', (chunk) => (output += String(chunk)))
    const exitCode = await new Promise<number | 'timeout'>((resolve, reject) => {
      const timeout = setTimeout(() => {
        killTree(child.pid)
        resolve('timeout')
      }, 10_000)
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timeout)
        resolve(code ?? -1)
      })
    })

    expect({ exitCode, dialogShown: existsSync(dialogMarkerPath) }, output).toEqual({
      exitCode: 1,
      dialogShown: false
    })
  }, 60_000)
})

function killTree(pid: number | undefined): void {
  if (!pid) {
    return
  }
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}
