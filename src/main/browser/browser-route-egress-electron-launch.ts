import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'

const electronBinary = createRequire(import.meta.url)('electron') as string

export type BrowserRouteEgressElectronResult = Record<string, unknown>

export async function runBrowserRouteEgressElectron(
  root: string,
  mainPath: string,
  extraElectronArgs: readonly string[] = []
): Promise<BrowserRouteEgressElectronResult> {
  const configPath = join(root, 'config.json')
  const resultPath = join(root, 'result.json')
  const electronArgs = [
    mainPath,
    configPath,
    `--user-data-dir=${join(root, 'profile')}`,
    ...extraElectronArgs
  ]
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const { executable, args } = resolveElectronProbeLaunch({
    electronBinary,
    electronArgs,
    platform: process.platform,
    display: env.DISPLAY
  })
  const child = spawn(executable, args, {
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const exit = waitForExit(child)
  let timedOut = false
  let termination: Promise<void> | null = null
  const terminate = (): Promise<void> => {
    termination ??= terminateProcessTree(child)
    return termination
  }
  // Why 60s: this bounds cold start plus the child's own watchdog, so the child's verdict wins the race. Startup
  // alone reached ~26s under reproduced contention and the widest child watchdog is 25s, which 30s could not cover.
  const timeout = setTimeout(() => {
    timedOut = true
    void terminate()
  }, 60_000)
  try {
    const output = await exit
    const rawResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
    if (timedOut || output.code !== 0 || rawResult === 'no result') {
      throw new Error(`${timedOut ? 'timeout' : output.code}\n${rawResult}\n${output.output}`)
    }
    const parsed = JSON.parse(rawResult) as BrowserRouteEgressElectronResult
    if (typeof parsed.error === 'string') {
      throw new Error(parsed.error)
    }
    return parsed
  } finally {
    clearTimeout(timeout)
    if (termination || (child.exitCode === null && child.signalCode === null)) {
      await terminate()
    }
  }
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let output = ''
    child.stdout?.on('data', (chunk) => (output += String(chunk)))
    child.stderr?.on('data', (chunk) => (output += String(chunk)))
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, output }))
  })
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    await waitForTermination(child, 5_000)
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return
  }
  await waitForTermination(child, 2_000)
  try {
    process.kill(-child.pid, 0)
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    return
  }
  await waitForTermination(child, 5_000)
}

function waitForTermination(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs)
    child.once('exit', done)
    function done(): void {
      clearTimeout(timeout)
      child.off('exit', done)
      resolve()
    }
  })
}
