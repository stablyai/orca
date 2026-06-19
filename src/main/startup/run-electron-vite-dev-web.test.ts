import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const processesToCleanUp = new Set<number>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await sleep(50)
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'ESRCH') {
      return false
    }
    throw error
  }
}

function readPidFile(pidFile: string): number[] {
  return readFileSync(pidFile, 'utf8')
    .trim()
    .split(/\s+/)
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isFinite(pid))
}

function trackPidFile(pidFile: string): number[] {
  const pids = readPidFile(pidFile)
  for (const pid of pids) {
    processesToCleanUp.add(pid)
  }
  return pids
}

function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Timed out waiting for dev wrapper exit'))
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function stopWrapper(wrapper: ChildProcess): Promise<void> {
  if (wrapper.pid) {
    processesToCleanUp.add(wrapper.pid)
  }
  if (wrapper.exitCode === null && wrapper.signalCode === null) {
    wrapper.kill('SIGINT')
  }
  await waitForExit(wrapper)
  if (wrapper.pid) {
    processesToCleanUp.delete(wrapper.pid)
  }
}

async function stopWrapperAndTrackedPids(wrapper: ChildProcess, pids: number[]): Promise<void> {
  await stopWrapper(wrapper)
  await waitFor(() => pids.every((pid) => !processExists(pid)))
  for (const pid of pids) {
    processesToCleanUp.delete(pid)
  }
}

function stashWebBuild(): () => void {
  const outWebPath = resolve('out/web')
  if (!existsSync(outWebPath)) {
    return () => {
      rmSync(outWebPath, { recursive: true, force: true })
    }
  }

  // Why: Windows temp can be on a different drive from the workspace, and
  // renameSync cannot move directories across devices.
  const tempDir = mkdtempSync(join(dirname(outWebPath), '.orca-dev-web-stash-'))
  const stashedPath = join(tempDir, 'web')
  renameSync(outWebPath, stashedPath)
  return () => {
    rmSync(outWebPath, { recursive: true, force: true })
    mkdirSync(resolve('out'), { recursive: true })
    renameSync(stashedPath, outWebPath)
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('run-electron-vite-dev web client prepare', () => {
  afterEach(async () => {
    for (const pid of processesToCleanUp) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null
        if (code !== 'ESRCH') {
          throw error
        }
      }
    }
    await sleep(100)
    for (const pid of processesToCleanUp) {
      try {
        if (processExists(pid)) {
          process.kill(pid, 'SIGKILL')
        }
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null
        if (code !== 'ESRCH') {
          throw error
        }
      }
    }
    processesToCleanUp.clear()
  })

  it('skips the initial web client build when no bundle exists', async () => {
    const restoreWebBuild = stashWebBuild()
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
    const pidFile = join(tempDir, 'grandchild.pid')
    const envFile = join(tempDir, 'env.json')
    const viteFile = join(tempDir, 'vite.txt')
    const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
    const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')
    const fakeVitePath = resolve('src/main/startup/__fixtures__/fake-vite-cli.mjs')
    let stderr = ''

    try {
      const wrapper = spawn(process.execPath, [wrapperPath, '--remote-debugging-port=9446'], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_VITE_CLI: fakeVitePath,
          ORCA_SKIP_DEV_CLI_PREPARE: '1',
          ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
          ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile,
          ORCA_DEV_WRAPPER_TEST_VITE_FILE: viteFile
        },
        stdio: ['ignore', 'ignore', 'pipe']
      })

      expect(wrapper.pid).toBeTypeOf('number')
      processesToCleanUp.add(wrapper.pid!)
      wrapper.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })

      await waitFor(() => {
        try {
          return readFileSync(envFile, 'utf8').trim().length > 0
        } catch {
          return false
        }
      })

      expect(existsSync(viteFile)).toBe(false)
      expect(stderr).toContain('Web client bundle missing; skipping pairing web build.')

      const trackedPids = trackPidFile(pidFile)

      await stopWrapperAndTrackedPids(wrapper, trackedPids)
    } finally {
      restoreWebBuild()
    }
  })

  it('builds the missing web client bundle when explicitly requested', async () => {
    const restoreWebBuild = stashWebBuild()
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'))
    const pidFile = join(tempDir, 'grandchild.pid')
    const envFile = join(tempDir, 'env.json')
    const viteFile = join(tempDir, 'vite.txt')
    const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs')
    const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs')
    const fakeVitePath = resolve('src/main/startup/__fixtures__/fake-vite-cli.mjs')

    try {
      const wrapper = spawn(process.execPath, [wrapperPath, '--remote-debugging-port=9447'], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          ORCA_ELECTRON_VITE_CLI: fakeCliPath,
          ORCA_VITE_CLI: fakeVitePath,
          ORCA_SKIP_DEV_CLI_PREPARE: '1',
          ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
          ORCA_DEV_WEB_PREPARE: '1',
          ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile,
          ORCA_DEV_WRAPPER_TEST_ENV_FILE: envFile,
          ORCA_DEV_WRAPPER_TEST_VITE_FILE: viteFile
        },
        stdio: 'ignore'
      })

      expect(wrapper.pid).toBeTypeOf('number')
      processesToCleanUp.add(wrapper.pid!)

      await waitFor(() => {
        try {
          return readFileSync(envFile, 'utf8').trim().length > 0
        } catch {
          return false
        }
      })

      expect(readFileSync(viteFile, 'utf8')).toContain('build')

      const trackedPids = trackPidFile(pidFile)

      await stopWrapperAndTrackedPids(wrapper, trackedPids)
    } finally {
      restoreWebBuild()
    }
  })
})
