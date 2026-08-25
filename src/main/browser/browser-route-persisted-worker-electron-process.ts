import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const electronBinary = createRequire(import.meta.url)('electron') as string

type PersistedWorkerElectronResult = {
  workerRunningBeforeForcedWake: boolean
  resolvedProxy: string
}

export async function runPersistedWorkerElectron(
  root: string,
  mainPath: string,
  configPath: string,
  mode: 'setup' | 'probe',
  onBarrier?: () => Promise<void>
): Promise<PersistedWorkerElectronResult> {
  const resultPath = join(root, 'result.json')
  rmSync(resultPath, { force: true })
  const electronArgs = [mainPath, configPath, mode, `--user-data-dir=${join(root, 'profile')}`]
  const executable = process.platform === 'linux' ? 'xvfb-run' : electronBinary
  const args =
    process.platform === 'linux'
      ? ['--auto-servernum', electronBinary, ...electronArgs, '--no-sandbox']
      : electronArgs
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
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
  const timeout = setTimeout(() => {
    timedOut = true
    void terminate()
  }, 30_000)
  try {
    const [, output] = await Promise.all([onBarrier?.() ?? Promise.resolve(), exit])
    const rawResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
    if (timedOut || output.code !== 0 || rawResult === 'no result') {
      throw new Error(`${timedOut ? 'timeout' : output.code}\n${rawResult}\n${output.output}`)
    }
    const result = JSON.parse(rawResult) as Record<string, unknown>
    if (typeof result.error === 'string') {
      throw new Error(result.error)
    }
    if (mode === 'setup') {
      if (result.registered !== true) {
        throw new Error('worker_probe_setup_result_invalid')
      }
      return { workerRunningBeforeForcedWake: false, resolvedProxy: '' }
    }
    if (
      !Object.hasOwn(result, 'workerRunningBeforeForcedWake') ||
      typeof result.workerRunningBeforeForcedWake !== 'boolean' ||
      !Object.hasOwn(result, 'resolvedProxy') ||
      typeof result.resolvedProxy !== 'string'
    ) {
      throw new Error('worker_probe_result_invalid')
    }
    return {
      workerRunningBeforeForcedWake: result.workerRunningBeforeForcedWake,
      resolvedProxy: result.resolvedProxy
    }
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
