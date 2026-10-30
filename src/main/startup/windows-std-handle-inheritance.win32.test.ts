import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip
const ADDON = resolve(__dirname, '..', '..', '..', 'native', 'windows-security', 'index.js')
const root = mkdtempSync(join(tmpdir(), 'orca-std-handles-'))
const entry = join(root, 'main.cjs')

/** Optionally clears, writes through a stdio:'inherit' grandchild, then leaves a detached
 * stdio:'ignore' holder behind, like the WSL holder or the daemon. */
writeFileSync(
  entry,
  `
const { spawn, spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const [mode, holderMs, pidFile] = process.argv.slice(-3)
if (mode === 'clear') {
  const failures = require(${JSON.stringify(ADDON)}).clearStdHandleInheritance()
  if (failures.length > 0) { writeFileSync(pidFile, JSON.stringify(failures)); process.exit(3) }
}
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
spawnSync(process.execPath, ['-e', 'process.stdout.write("inherited-output\\\\n")'], { stdio: 'inherit', env, windowsHide: true })
const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + holderMs + ')'], { stdio: 'ignore', detached: true, env, windowsHide: true })
holder.unref()
writeFileSync(pidFile, String(holder.pid))
if (process.type === 'browser') require('electron').app.exit(0)
`
)

afterAll(() => rmSync(root, { recursive: true, force: true }))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Electron main is Orca's real shape: it keeps std handles inheritable (kEnableStdioInheritance),
 * where plain Node clears them itself at startup. */
async function runChild(host: 'electron' | 'node', mode: 'clear' | 'keep', holderMs: number) {
  const electron: unknown = createRequire(import.meta.url)('electron')
  if (typeof electron !== 'string') {
    throw new Error('Electron executable is unavailable')
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const pidFile = join(root, `${host}-${mode}.pid`)
  const child = spawnProcess({
    program: host === 'electron' ? electron : process.execPath,
    args: [entry, mode, String(holderMs), pidFile],
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout?.on('data', (chunk) => (output += chunk))
  child.stderr?.on('data', (chunk) => (output += chunk))
  const [code] = await once(child, 'close', { signal: AbortSignal.timeout(holderMs + 30_000) })
  const pidText = readFileSync(pidFile, 'utf8')
  const holderPid = Number(pidText)
  const holderAliveAtClose = isAlive(holderPid)
  if (holderAliveAtClose) {
    process.kill(holderPid)
  }
  return { code, output, pidText, holderAliveAtClose }
}

describeOnWindows('clearing std handle inheritance', () => {
  // A regression pins the pipe for the 60 s holder; fail on the assertion, not the 5 s default.
  it('keeps stdio inherit output and frees the pipe while a detached holder lives', async () => {
    const run = await runChild('electron', 'clear', 60_000)

    expect(run.code, run.output).toBe(0)
    expect(run.pidText).toMatch(/^\d+$/)
    expect(run.output).toContain('inherited-output')
    expect(run.holderAliveAtClose).toBe(true)
  }, 90_000)

  // Cold Electron start on a CI runner plus the 3 s holder exceeds the 5 s default.
  it('without it, Electron main lets the holder keep the pipe open until it exits', async () => {
    const run = await runChild('electron', 'keep', 3_000)

    expect(run.code, run.output).toBe(0)
    expect(run.output).toContain('inherited-output')
    expect(run.holderAliveAtClose).toBe(false)
  }, 60_000)

  // A regression pins the pipe for the 60 s holder; fail on the assertion, not the 5 s default.
  it('plain Node already clears its own std handles, so it is no model for Orca', async () => {
    const run = await runChild('node', 'keep', 60_000)

    expect(run.code, run.output).toBe(0)
    expect(run.output).toContain('inherited-output')
    expect(run.holderAliveAtClose).toBe(true)
  }, 90_000)
})
